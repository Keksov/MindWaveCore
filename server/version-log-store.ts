// version-log-store (VL1.1, plan docs/undo-versioned-log): a generic append-only commit log with
// refs, stored as NDJSON segments + refs.json inside a log directory (per-project layout puts it
// at <projectDir>/undo-log/, VL-D3).
//
// The store is content-agnostic (VL-D1): commit payloads are opaque JSON — GTrack semantics live
// client-side. Data model (VL-D2): commits form a parent-linked chain; refs.main is the tip of
// the linear history, refs.head is the undo cursor, refs.tags are named pins (VL-D9). Commits
// are immutable once written (S1), appends are idempotent by cid (S2), chain integrity is
// enforced on append (S3) and re-checked on load, where a violation is treated as corruption and
// repaired tolerantly (S6/S7) — a torn tail is truncated, a corrupt middle is cut with the
// remainder preserved in *.broken-<ts> (never silently destroyed, the project-store idiom).

import { randomUUID } from "node:crypto"
import type { Dirent } from "node:fs"
import { appendFile, mkdir, readFile, readdir, rename, rm, truncate, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { SerialQueues } from "./project-store"
import { perfLog, perfNow } from "./undo-log-perf-log"

export const VERSION_LOG_REFS_FILE_NAME = "refs.json"
/** S10: the log itself is unbounded — only a single commit has a sanity cap. */
export const VERSION_LOG_COMMIT_MAX_BYTES = 32 * 1024 * 1024
export const VERSION_LOG_SEGMENT_MAX_BYTES = 4 * 1024 * 1024
export const VERSION_LOG_TAG_NAME_MAX_LENGTH = 64

const SEGMENT_FILE_PATTERN = /^seg-(\d{8})\.jsonl$/
const REFS_SCHEMA_VERSION = 1
const CID_MAX_LENGTH = 200

export type VersionLogCommitType = "snapshot" | "delta" | "meta"

export interface VersionLogCommitInput {
  readonly cid: string
  /** cid of the parent commit; null is allowed only for the root of an empty log (S3). */
  readonly parent: string | null
  readonly type: VersionLogCommitType
  readonly atMs: number
  readonly payload: unknown
}

export interface VersionLogCommit extends VersionLogCommitInput {
  /** Server-assigned, strictly increasing in write order (S4). */
  readonly seq: number
}

export interface VersionLogRefs {
  readonly main: string | null
  readonly head: string | null
  readonly tags: Readonly<Record<string, string>>
}

export interface VersionLogRefsPatch {
  readonly main?: string | null
  readonly head?: string | null
  /** name -> cid to set, name -> null to delete the tag. */
  readonly tags?: Readonly<Record<string, string | null>>
}

export interface VersionLogGcPolicy {
  /** 0 or absent = unlimited (the VL-D6 settings semantics). */
  readonly maxCommits?: number
  readonly maxAgeMs?: number
  readonly maxBytes?: number
  /** Age reference point; tests pass it for determinism, callers may omit (Date.now()). */
  readonly nowMs?: number
}

export interface VersionLogAppendOptions {
  /** Move refs.main to the last batch commit present in the log after the call (S5). */
  readonly advanceMain?: boolean
  /** Run GC after the append when any of these limits is violated (VL-D6). */
  readonly gc?: VersionLogGcPolicy
}

export interface VersionLogAppendResult {
  readonly appended: number
  readonly skipped: number
  /** First rejected cid when the batch was cut (S3); the accepted prefix IS persisted. */
  readonly rejectedFrom: string | null
  readonly rejectedReason: "unknown-parent" | null
  readonly refs: VersionLogRefs
}

export interface VersionLogChainOptions {
  /** 'main' | 'head' | a concrete cid (404 when the cid is unknown). */
  readonly from: string
  readonly limit?: number
  /** Walk until (and including) the first commit of this type — the adoption read (VL-D5). */
  readonly untilType?: VersionLogCommitType
}

export interface VersionLogChain {
  /** Newest-first: commits[0] is `from`, each next one is the parent of the previous. */
  readonly commits: readonly VersionLogCommit[]
  readonly refs: VersionLogRefs
  readonly hasMore: boolean
}

export interface VersionLogStats {
  readonly commits: number
  readonly bytes: number
  readonly segments: number
  readonly orphans: number
}

/** undo-orphan-branches (OB-D1/OB-D4): one abandoned line of history. A branch is identified by
 *  its TIP — a commit unreachable from {main, head} with no children. Tags deliberately do NOT
 *  count as line roots here (or tagging a branch would hide it from the list); they still protect
 *  chains from GC as before. Sub-branches of a shared prefix each carry the prefix in their own
 *  chain (flat-tips semantics). */
export interface VersionLogBranch {
  readonly tip: string
  /** Nearest line-reachable ancestor, or null (graft/cut root) — not part of the chain itself. */
  readonly forkParent: string | null
  /** Chain length above forkParent: GET from=tip&limit=commits returns exactly the branch. */
  readonly commits: number
  /** The suffix owned by this tip alone — what deleteBranch(tip) removes (OB-D3). */
  readonly exclusiveCommits: number
  readonly fromMs: number
  readonly toMs: number
  readonly snapshots: number
  /** Tag names pointing at commits of this chain (GC-protection badges). */
  readonly tags: readonly string[]
}

export class VersionLogError extends Error {
  public readonly status: number

  public constructor(aStatus: number, aMessage: string) {
    super(aMessage)
    this.name = "VersionLogError"
    this.status = aStatus
  }
}

export const isVersionLogError = (aValue: unknown): aValue is VersionLogError => {
  return aValue instanceof VersionLogError
}

export interface VersionLogStoreOptions {
  /** Segment rotation threshold; tests pass a small value to exercise rollover. */
  readonly segmentMaxBytes?: number
  /** Per-commit sanity cap (S10). */
  readonly commitMaxBytes?: number
}

export interface VersionLogStore {
  append(aLogDir: string, aCommits: readonly VersionLogCommitInput[], aOptions?: VersionLogAppendOptions): Promise<VersionLogAppendResult>
  readChain(aLogDir: string, aOptions: VersionLogChainOptions): Promise<VersionLogChain>
  /** Every commit in seq order — orphans included (fuzz/oracle comparison, export bundle S15). */
  listCommits(aLogDir: string): Promise<readonly VersionLogCommit[]>
  getRefs(aLogDir: string): Promise<VersionLogRefs>
  putRefs(aLogDir: string, aPatch: VersionLogRefsPatch): Promise<VersionLogRefs>
  stats(aLogDir: string): Promise<VersionLogStats>
  /** B1..B4: flat list of abandoned-line tips, newest-first (line-reachability = {main, head}). */
  listBranches(aLogDir: string): Promise<readonly VersionLogBranch[]>
  /** B5..B7 (OB-D3): physically delete the exclusive suffix of a branch tip — the only targeted
   *  mutation besides GC. 404 unknown cid; 409 not-a-tip or a tag inside the exclusive suffix.
   *  Returns the number of deleted commits. */
  deleteBranch(aLogDir: string, aTip: string): Promise<number>
  /** S8: orphans first, then the main-chain prefix above the newest snapshot anchor that fits
   *  the policy; protected chains (head, tags) survive; kept commits whose parent was removed
   *  are grafted to parent=null. Never leaves a snapshot-anchored log without its anchor. */
  gc(aLogDir: string, aPolicy: VersionLogGcPolicy): Promise<VersionLogStats>
  /** S15: raw restore of an exported log (bundle import). Unlike append, STORED-log rules apply:
   *  graft roots (null parent) are valid anywhere and original seqs are preserved byte-for-byte;
   *  the previous content of the dir is replaced. */
  importLog(aLogDir: string, aCommits: readonly VersionLogCommit[], aRefs: VersionLogRefs): Promise<void>
  /** S12: back to the initial state — segments and refs removed, next append starts a new root. */
  clear(aLogDir: string): Promise<void>
  /** Drop the in-memory cache for a dir (tests use it to simulate a process restart). */
  forget(aLogDir: string): void
}

// --- internal state -------------------------------------------------------------------------

interface SegmentState {
  readonly name: string
  bytes: number
}

interface MutableRefs {
  main: string | null
  head: string | null
  tags: Record<string, string>
}

interface LogState {
  readonly commits: Map<string, VersionLogCommit>
  readonly order: VersionLogCommit[]
  nextSeq: number
  refs: MutableRefs
  segments: SegmentState[]
  /** Last segment ends without a newline (complete final record, torn '\n') — prefix one. */
  tailNeedsNewline: boolean
}

const isRecordValue = (aValue: unknown): aValue is Record<string, unknown> => {
  return aValue !== null && typeof aValue === "object" && !Array.isArray(aValue)
}

const isCommitType = (aValue: unknown): aValue is VersionLogCommitType => {
  return aValue === "snapshot" || aValue === "delta" || aValue === "meta"
}

const isValidCid = (aValue: unknown): aValue is string => {
  return typeof aValue === "string" && aValue.length > 0 && aValue.length <= CID_MAX_LENGTH
}

const isValidTagName = (aValue: string): boolean => {
  if (aValue.length === 0 || aValue.length > VERSION_LOG_TAG_NAME_MAX_LENGTH) {
    return false
  }

  for (const char of aValue) {
    if (char.charCodeAt(0) < 0x20 || char.trim() === "") {
      return false
    }
  }

  return true
}

/** Shape check for a persisted line; seq monotonicity is enforced by the caller. */
const isStoredCommit = (aValue: unknown): aValue is VersionLogCommit => {
  if (!isRecordValue(aValue)) {
    return false
  }

  return (
    typeof aValue.seq === "number" &&
    Number.isFinite(aValue.seq) &&
    isValidCid(aValue.cid) &&
    (aValue.parent === null || isValidCid(aValue.parent)) &&
    isCommitType(aValue.type) &&
    typeof aValue.atMs === "number" &&
    Number.isFinite(aValue.atMs)
  )
}

const formatFileTimestamp = (aDate: Date): string => {
  const pad = (aValue: number, aWidth: number): string => String(aValue).padStart(aWidth, "0")
  const date = `${aDate.getFullYear()}-${pad(aDate.getMonth() + 1, 2)}-${pad(aDate.getDate(), 2)}`
  const time = `${pad(aDate.getHours(), 2)}-${pad(aDate.getMinutes(), 2)}-${pad(aDate.getSeconds(), 2)}-${pad(aDate.getMilliseconds(), 3)}`
  return `${date}_${time}`
}

const segmentFileName = (aIndex: number): string => {
  return `seg-${String(aIndex).padStart(8, "0")}.jsonl`
}

const segmentIndex = (aName: string): number => {
  const match = SEGMENT_FILE_PATTERN.exec(aName)
  return match === null ? 0 : Number(match[1])
}

const encodeCommitLine = (aCommit: VersionLogCommit): string => {
  // JSON.stringify never emits a literal newline, so one line is always one commit (VL-D3).
  return `${JSON.stringify(aCommit)}\n`
}

const cloneRefs = (aRefs: MutableRefs): VersionLogRefs => {
  return { main: aRefs.main, head: aRefs.head, tags: { ...aRefs.tags } }
}

interface ParsedSegmentEntry {
  readonly text: string
  /** Byte offset of the line start within the segment file. */
  readonly start: number
  /** True when the line is terminated by '\n' (a complete NDJSON record boundary). */
  readonly terminated: boolean
}

const splitSegmentLines = (aBuffer: Buffer): ParsedSegmentEntry[] => {
  const entries: ParsedSegmentEntry[] = []
  let start = 0

  while (start < aBuffer.length) {
    const newline = aBuffer.indexOf(0x0a, start)
    if (newline === -1) {
      entries.push({ text: aBuffer.subarray(start).toString("utf8"), start, terminated: false })
      break
    }

    entries.push({ text: aBuffer.subarray(start, newline).toString("utf8"), start, terminated: true })
    start = newline + 1
  }

  return entries
}

// --- store implementation -------------------------------------------------------------------

class VersionLogStoreImpl implements VersionLogStore {
  private readonly queues = new SerialQueues()
  private readonly states = new Map<string, LogState>()
  private readonly segmentMaxBytes: number
  private readonly commitMaxBytes: number

  public constructor(aOptions: VersionLogStoreOptions = {}) {
    this.segmentMaxBytes = aOptions.segmentMaxBytes ?? VERSION_LOG_SEGMENT_MAX_BYTES
    this.commitMaxBytes = aOptions.commitMaxBytes ?? VERSION_LOG_COMMIT_MAX_BYTES
  }

  public async append(
    aLogDir: string,
    aCommits: readonly VersionLogCommitInput[],
    aOptions: VersionLogAppendOptions = {},
  ): Promise<VersionLogAppendResult> {
    return this.withDir(aLogDir, async (dir, state) => {
      const perfStart = perfNow()
      for (const input of aCommits) {
        this.assertValidInput(input)
      }

      // Decide the accepted prefix first (S2/S3): duplicates are skipped wherever they appear;
      // the first NEW commit whose parent is neither persisted nor accepted earlier in the batch
      // cuts the batch — everything before the cut is applied, the rest is rejected.
      const accepted: VersionLogCommitInput[] = []
      const knownInBatch = new Set<string>()
      let skipped = 0
      let rejectedFrom: string | null = null
      let lastPresentCid: string | null = null

      for (const input of aCommits) {
        if (state.commits.has(input.cid) || knownInBatch.has(input.cid)) {
          skipped += 1
          lastPresentCid = input.cid
          continue
        }

        const parentKnown =
          input.parent === null
            ? state.commits.size === 0 && accepted.length === 0
            : state.commits.has(input.parent) || knownInBatch.has(input.parent)
        if (!parentKnown) {
          rejectedFrom = input.cid
          break
        }

        accepted.push(input)
        knownInBatch.add(input.cid)
        lastPresentCid = input.cid
      }

      // S10: size-validate the whole call BEFORE writing anything — an oversized commit rejects
      // the append atomically (the log stays unchanged).
      const stamped = accepted.map((aInput, aIndex): VersionLogCommit => {
        return {
          cid: aInput.cid,
          parent: aInput.parent,
          type: aInput.type,
          atMs: aInput.atMs,
          payload: aInput.payload ?? null,
          seq: state.nextSeq + aIndex,
        }
      })
      const lines = stamped.map(encodeCommitLine)
      for (const line of lines) {
        if (Buffer.byteLength(line, "utf8") > this.commitMaxBytes) {
          throw new VersionLogError(413, "Commit exceeds the per-commit size limit")
        }
      }

      if (stamped.length > 0) {
        const writeStart = perfNow()
        await this.writeLines(dir, state, stamped, lines)
        perfLog("append:writeLines", writeStart, {
          commits: stamped.length,
          bytes: lines.reduce((n, l) => n + l.length, 0),
        })
      }

      if (aOptions.advanceMain === true && lastPresentCid !== null) {
        state.refs.main = lastPresentCid
        const refsStart = perfNow()
        await this.writeRefs(dir, state)
        perfLog("append:writeRefs", refsStart)
      }

      if (aOptions.gc !== undefined && this.gcTriggered(state, aOptions.gc)) {
        const gcStart = perfNow()
        state = await this.runGc(dir, state, aOptions.gc)
        perfLog("append:runGc", gcStart, { commitsAfter: state.order.length })
      }

      perfLog("append", perfStart, {
        received: aCommits.length,
        appended: stamped.length,
        skipped,
        totalCommits: state.order.length,
      })
      return {
        appended: stamped.length,
        skipped,
        rejectedFrom,
        rejectedReason: rejectedFrom === null ? null : "unknown-parent",
        refs: cloneRefs(state.refs),
      }
    })
  }

  public async gc(aLogDir: string, aPolicy: VersionLogGcPolicy): Promise<VersionLogStats> {
    return this.withDir(aLogDir, async (dir, state) => {
      const fresh = await this.runGc(dir, state, aPolicy)
      return this.buildStats(fresh)
    })
  }

  public async readChain(aLogDir: string, aOptions: VersionLogChainOptions): Promise<VersionLogChain> {
    return this.withDir(aLogDir, async (_dir, state) => {
      const fromCid = this.resolveRef(state, aOptions.from)
      if (fromCid === null) {
        return { commits: [], refs: cloneRefs(state.refs), hasMore: false }
      }

      const start = state.commits.get(fromCid)
      if (start === undefined) {
        throw new VersionLogError(404, `Unknown commit: ${aOptions.from}`)
      }

      const limit = aOptions.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, aOptions.limit)
      const commits: VersionLogCommit[] = []
      let current: VersionLogCommit | undefined = start
      let hasMore = false

      while (current !== undefined) {
        if (commits.length >= limit) {
          hasMore = true
          break
        }

        commits.push(current)
        if (aOptions.untilType !== undefined && current.type === aOptions.untilType) {
          hasMore = current.parent !== null
          break
        }

        if (current.parent === null) {
          break
        }

        // A missing parent cannot happen after a clean load (S3/S7 repair) — guard anyway.
        current = state.commits.get(current.parent)
      }

      return { commits, refs: cloneRefs(state.refs), hasMore }
    })
  }

  public async listCommits(aLogDir: string): Promise<readonly VersionLogCommit[]> {
    return this.withDir(aLogDir, async (_dir, state) => {
      return [...state.order]
    })
  }

  public async getRefs(aLogDir: string): Promise<VersionLogRefs> {
    return this.withDir(aLogDir, async (_dir, state) => {
      return cloneRefs(state.refs)
    })
  }

  public async putRefs(aLogDir: string, aPatch: VersionLogRefsPatch): Promise<VersionLogRefs> {
    return this.withDir(aLogDir, async (dir, state) => {
      // Validate the whole patch first (S5): a bad entry must not partially apply refs.
      const assertKnown = (aCid: string | null | undefined): void => {
        if (typeof aCid === "string" && !state.commits.has(aCid)) {
          throw new VersionLogError(404, `Unknown commit: ${aCid}`)
        }
      }
      assertKnown(aPatch.main)
      assertKnown(aPatch.head)

      const tagPatch = aPatch.tags ?? {}
      for (const [name, cid] of Object.entries(tagPatch)) {
        if (!isValidTagName(name)) {
          throw new VersionLogError(400, `Invalid tag name: ${JSON.stringify(name)}`)
        }
        assertKnown(cid)
      }

      if (aPatch.main !== undefined) {
        state.refs.main = aPatch.main
      }
      if (aPatch.head !== undefined) {
        state.refs.head = aPatch.head
      }
      for (const [name, cid] of Object.entries(tagPatch)) {
        if (cid === null) {
          delete state.refs.tags[name]
        } else {
          state.refs.tags[name] = cid
        }
      }

      await this.writeRefs(dir, state)
      return cloneRefs(state.refs)
    })
  }

  public async stats(aLogDir: string): Promise<VersionLogStats> {
    return this.withDir(aLogDir, async (_dir, state) => {
      return this.buildStats(state)
    })
  }

  public async listBranches(aLogDir: string): Promise<readonly VersionLogBranch[]> {
    return this.withDir(aLogDir, async (_dir, state) => {
      const perfStart = perfNow()
      const branches = this.computeBranches(state)
      perfLog("listBranches", perfStart, { commits: state.order.length, branches: branches.length })
      return branches
    })
  }

  public async deleteBranch(aLogDir: string, aTip: string): Promise<number> {
    return this.withDir(aLogDir, async (dir, state) => {
      const perfStart = perfNow()
      const tip = state.commits.get(aTip)
      if (tip === undefined) {
        throw new VersionLogError(404, `Unknown commit: ${aTip}`)
      }

      const line = this.collectLineReachable(state)
      const childCount = new Map<string, number>()
      for (const commit of state.order) {
        if (commit.parent !== null) {
          childCount.set(commit.parent, (childCount.get(commit.parent) ?? 0) + 1)
        }
      }
      if (line.has(tip.cid) || (childCount.get(tip.cid) ?? 0) > 0) {
        throw new VersionLogError(409, `Not a branch tip: ${aTip}`)
      }

      // The exclusive suffix (OB-D3): walk down while each commit is the only child of its
      // parent link; a second child (a shared sub-branch prefix) or the line stops the walk.
      // A tag anywhere inside the suffix refuses the whole deletion (B6).
      const tagged = new Set(Object.values(state.refs.tags))
      const doomed = new Set<string>()
      let current: VersionLogCommit = tip
      for (;;) {
        if (tagged.has(current.cid)) {
          throw new VersionLogError(409, `Branch is tagged at ${current.cid}; remove the tag first`)
        }
        doomed.add(current.cid)
        if (current.parent === null) {
          break
        }
        const parent = state.commits.get(current.parent)
        if (parent === undefined || line.has(parent.cid) || (childCount.get(parent.cid) ?? 0) > 1) {
          break
        }
        current = parent
      }

      // B5: the doomed set is child-closed by construction, so no kept commit can lose its
      // parent — deleteBranch never grafts. Guarded, not assumed.
      const kept: VersionLogCommit[] = []
      for (const commit of state.order) {
        if (doomed.has(commit.cid)) {
          continue
        }
        if (commit.parent !== null && doomed.has(commit.parent)) {
          throw new VersionLogError(500, "deleteBranch invariant violated: a kept child of a deleted commit")
        }
        kept.push(commit)
      }

      const rewriteStart = perfNow()
      await this.rewriteLog(dir, state, kept)
      perfLog("deleteBranch:rewriteLog", rewriteStart, { kept: kept.length, doomed: doomed.size })
      perfLog("deleteBranch", perfStart, { totalCommits: state.order.length, doomed: doomed.size })
      return doomed.size
    })
  }

  public async importLog(aLogDir: string, aCommits: readonly VersionLogCommit[], aRefs: VersionLogRefs): Promise<void> {
    return this.withDir(aLogDir, async (dir) => {
      // Stored-log validation (S15): seq strictly increasing, cids unique, a non-null parent
      // must appear earlier (listCommits order guarantees it for orphans too), null parents are
      // legal anywhere (graft roots after GC).
      const seen = new Set<string>()
      let previousSeq = 0
      for (const commit of aCommits) {
        if (
          !isStoredCommit(commit) ||
          seen.has(commit.cid) ||
          commit.seq <= previousSeq ||
          (commit.parent !== null && !seen.has(commit.parent))
        ) {
          throw new VersionLogError(400, "Invalid undo-log bundle")
        }
        seen.add(commit.cid)
        previousSeq = commit.seq
      }

      const assertRef = (aCid: string | null): void => {
        if (aCid !== null && !seen.has(aCid)) {
          throw new VersionLogError(400, "Invalid undo-log bundle refs")
        }
      }
      assertRef(aRefs.main)
      assertRef(aRefs.head)
      for (const [name, cid] of Object.entries(aRefs.tags ?? {})) {
        if (!isValidTagName(name)) {
          throw new VersionLogError(400, "Invalid undo-log bundle refs")
        }
        assertRef(cid)
      }

      await rm(dir, { recursive: true, force: true })
      const key = this.stateKey(dir)
      this.states.delete(key)
      if (aCommits.length === 0 && aRefs.main === null && aRefs.head === null && Object.keys(aRefs.tags ?? {}).length === 0) {
        return // an empty bundle restores to the pristine no-log state
      }

      await mkdir(dir, { recursive: true })
      const lines = aCommits
        .map((aCommit) => encodeCommitLine({ ...aCommit, payload: aCommit.payload ?? null }))
        .join("")
      await writeFile(join(dir, segmentFileName(1)), lines, "utf8")

      const fresh = await this.loadState(dir)
      fresh.refs.main = aRefs.main
      fresh.refs.head = aRefs.head
      fresh.refs.tags = { ...(aRefs.tags ?? {}) }
      await this.writeRefs(dir, fresh)
      this.states.set(key, fresh)
    })
  }

  public async clear(aLogDir: string): Promise<void> {
    return this.withDir(aLogDir, async (dir) => {
      await rm(dir, { recursive: true, force: true })
      this.states.delete(this.stateKey(dir))
    })
  }

  public forget(aLogDir: string): void {
    this.states.delete(this.stateKey(resolve(aLogDir)))
  }

  // --- shared plumbing ----------------------------------------------------------------------

  private stateKey(aResolvedDir: string): string {
    return aResolvedDir.toLowerCase()
  }

  private async withDir<T>(aLogDir: string, aAction: (aDir: string, aState: LogState) => Promise<T>): Promise<T> {
    const dir = resolve(aLogDir)
    const key = this.stateKey(dir)
    const queueStart = perfNow()

    // Per-dir serialization (S11): loads and mutations of one log never interleave.
    return this.queues.run(key, async () => {
      const queueMs = perfNow() - queueStart
      if (queueMs > 5) perfLog("withDir queue wait", queueStart, { dir: key })
      let state = this.states.get(key)
      if (state === undefined) {
        const loadStart = perfNow()
        state = await this.loadState(dir)
        perfLog("withDir loadState (cold)", loadStart, {
          dir: key,
          commits: state.order.length,
          segments: state.segments.length,
        })
        this.states.set(key, state)
      }

      return aAction(dir, state)
    })
  }

  private assertValidInput(aInput: VersionLogCommitInput): void {
    if (!isRecordValue(aInput)) {
      throw new VersionLogError(400, "Invalid commit shape")
    }
    if (
      !isValidCid(aInput.cid) ||
      !(aInput.parent === null || isValidCid(aInput.parent)) ||
      !isCommitType(aInput.type) ||
      typeof aInput.atMs !== "number" ||
      !Number.isFinite(aInput.atMs)
    ) {
      throw new VersionLogError(400, "Invalid commit shape")
    }
  }

  private resolveRef(aState: LogState, aFrom: string): string | null {
    if (aFrom === "main") {
      return aState.refs.main
    }
    if (aFrom === "head") {
      return aState.refs.head
    }
    return aFrom
  }

  private buildStats(aState: LogState): VersionLogStats {
    const reachable = this.collectReachable(aState)
    return {
      commits: aState.order.length,
      bytes: aState.segments.reduce((aSum, aSegment) => aSum + aSegment.bytes, 0),
      segments: aState.segments.length,
      orphans: aState.order.length - reachable.size,
    }
  }

  // --- GC (VL2.1, S8) -----------------------------------------------------------------------

  /** Append-time trigger (VL-D6): GC runs only when a set limit is actually violated. */
  private gcTriggered(aState: LogState, aPolicy: VersionLogGcPolicy): boolean {
    const bytes = aState.segments.reduce((aSum, aSegment) => aSum + aSegment.bytes, 0)
    const oldest = aState.order[0]
    const nowMs = aPolicy.nowMs ?? Date.now()

    return (
      (aPolicy.maxCommits !== undefined && aPolicy.maxCommits > 0 && aState.order.length > aPolicy.maxCommits) ||
      (aPolicy.maxBytes !== undefined && aPolicy.maxBytes > 0 && bytes > aPolicy.maxBytes) ||
      (aPolicy.maxAgeMs !== undefined && aPolicy.maxAgeMs > 0 && oldest !== undefined && oldest.atMs < nowMs - aPolicy.maxAgeMs)
    )
  }

  /** The kept-and-grafted log under a policy, or null when GC would change nothing. */
  private computeGcKeep(aState: LogState, aPolicy: VersionLogGcPolicy): VersionLogCommit[] | null {
    if (aState.order.length === 0) {
      return null
    }

    const reachable = this.collectReachable(aState)

    // Anchor candidates: snapshots on the main chain, oldest-first — the oldest anchor whose
    // kept set fits the limits keeps the most history; the newest one is the fallback (S8в:
    // the minimal chain survives even when it exceeds the limits).
    const mainChain: VersionLogCommit[] = []
    for (let cid = aState.refs.main; cid !== null; ) {
      const commit = aState.commits.get(cid)
      if (commit === undefined) {
        break
      }
      mainChain.push(commit)
      cid = commit.parent
    }
    const anchors = mainChain.filter((aCommit) => aCommit.type === "snapshot")

    let keepSet: Set<string> | undefined
    if (anchors.length === 0) {
      // No snapshot anchor to cut at — orphan removal only (the log is never left anchorless).
      keepSet = reachable
    } else {
      for (let index = anchors.length - 1; index >= 0; index -= 1) {
        const candidate = anchors[index]!
        const candidateKeep = this.computeKeepFor(aState, candidate)
        if (this.gcFits(aState, candidateKeep, candidate, aPolicy)) {
          keepSet = candidateKeep
          break
        }
      }
      // Nothing fits: the minimal chain from the NEWEST anchor stays anyway (S8в).
      keepSet ??= this.computeKeepFor(aState, anchors[0]!)
    }

    const kept = aState.order.filter((aCommit) => keepSet.has(aCommit.cid))
    if (kept.length === aState.order.length) {
      return null
    }

    // Graft: a kept commit whose parent was removed becomes a root (git shallow semantics) —
    // otherwise the surviving chain would dangle and the next load would cut it as corrupt.
    return kept.map((aCommit) => {
      return aCommit.parent !== null && !keepSet.has(aCommit.parent) ? { ...aCommit, parent: null } : aCommit
    })
  }

  /** Kept set for an anchor: [anchor..main] + every protected chain (head, tags) down to its
   *  own snapshot/root or the first commit already kept. */
  private computeKeepFor(aState: LogState, aAnchor: VersionLogCommit): Set<string> {
    const keep = new Set<string>()

    for (let cid = aState.refs.main; cid !== null; ) {
      const commit = aState.commits.get(cid)
      if (commit === undefined) {
        break
      }
      keep.add(cid)
      if (cid === aAnchor.cid) {
        break
      }
      cid = commit.parent
    }

    const protectedRoots = [aState.refs.head, ...Object.values(aState.refs.tags)]
    for (const root of protectedRoots) {
      for (let cid = root; cid !== null && !keep.has(cid); ) {
        const commit = aState.commits.get(cid)
        if (commit === undefined) {
          break
        }
        keep.add(cid)
        if (commit.type === "snapshot") {
          break
        }
        cid = commit.parent
      }
    }

    return keep
  }

  private gcFits(aState: LogState, aKeep: Set<string>, aAnchor: VersionLogCommit, aPolicy: VersionLogGcPolicy): boolean {
    if (aPolicy.maxCommits !== undefined && aPolicy.maxCommits > 0 && aKeep.size > aPolicy.maxCommits) {
      return false
    }

    if (aPolicy.maxAgeMs !== undefined && aPolicy.maxAgeMs > 0) {
      const nowMs = aPolicy.nowMs ?? Date.now()
      if (aAnchor.atMs < nowMs - aPolicy.maxAgeMs) {
        return false
      }
    }

    if (aPolicy.maxBytes !== undefined && aPolicy.maxBytes > 0) {
      let bytes = 0
      for (const cid of aKeep) {
        const commit = aState.commits.get(cid)!
        const grafted = commit.parent !== null && !aKeep.has(commit.parent) ? { ...commit, parent: null } : commit
        bytes += Buffer.byteLength(encodeCommitLine(grafted), "utf8")
      }
      if (bytes > aPolicy.maxBytes) {
        return false
      }
    }

    return true
  }

  private async runGc(aDir: string, aState: LogState, aPolicy: VersionLogGcPolicy): Promise<LogState> {
    const kept = this.computeGcKeep(aState, aPolicy)
    if (kept === null) {
      return aState
    }

    return this.rewriteLog(aDir, aState, kept)
  }

  /** Consolidate the kept log into seg-00000001.jsonl (atomic rename-over), drop the rest, then
   *  reload from disk — shared by GC and deleteBranch. The load path is the single source of
   *  truth for state construction, and its repair logic also reconciles any crash inside here. */
  private async rewriteLog(aDir: string, aState: LogState, aKept: readonly VersionLogCommit[]): Promise<LogState> {
    const key = this.stateKey(aDir)
    try {
      const tempPath = join(aDir, `.seg-gcnew-${randomUUID()}`)
      await writeFile(tempPath, aKept.map(encodeCommitLine).join(""), "utf8")
      await rename(tempPath, join(aDir, segmentFileName(1)))

      for (const segment of aState.segments) {
        if (segment.name !== segmentFileName(1)) {
          await rm(join(aDir, segment.name), { force: true })
        }
      }
    } finally {
      // Success or failure alike: drop the cache so the next access rebuilds from disk; the
      // consolidated segment + the load-time seq/chain cuts converge to the rewritten state.
      this.states.delete(key)
    }

    const fresh = await this.loadState(aDir)
    this.states.set(key, fresh)
    return fresh
  }

  /** GC-reachability (S8): {main, head, tags} — what survives a policy sweep. */
  private collectReachable(aState: LogState): Set<string> {
    return this.walkReachable(aState, [aState.refs.main, aState.refs.head, ...Object.values(aState.refs.tags)])
  }

  /** Line-reachability (OB-D4): {main, head} only — tags kept out so a tagged branch stays in
   *  the branches list (protected and badged) instead of vanishing the moment it is tagged. */
  private collectLineReachable(aState: LogState): Set<string> {
    return this.walkReachable(aState, [aState.refs.main, aState.refs.head])
  }

  private walkReachable(aState: LogState, aRoots: readonly (string | null)[]): Set<string> {
    const reachable = new Set<string>()

    for (const root of aRoots) {
      let cid = root
      while (cid !== null && !reachable.has(cid)) {
        const commit = aState.commits.get(cid)
        if (commit === undefined) {
          break
        }
        reachable.add(cid)
        cid = commit.parent
      }
    }

    return reachable
  }

  /** undo-orphan-branches B1..B4 (OB-D1): every childless line-unreachable commit is a tip; its
   *  chain runs down to (not including) the nearest line-reachable ancestor. `exclusiveCommits`
   *  counts the suffix this tip owns alone — the walk stays exclusive while each commit is the
   *  only child of its parent link; the first commit with a second child (a shared sub-branch
   *  prefix) ends it. */
  private computeBranches(aState: LogState): VersionLogBranch[] {
    const line = this.collectLineReachable(aState)

    const childCount = new Map<string, number>()
    for (const commit of aState.order) {
      if (commit.parent !== null) {
        childCount.set(commit.parent, (childCount.get(commit.parent) ?? 0) + 1)
      }
    }

    const tagsByCid = new Map<string, string[]>()
    for (const [name, cid] of Object.entries(aState.refs.tags)) {
      const names = tagsByCid.get(cid)
      if (names === undefined) {
        tagsByCid.set(cid, [name])
      } else {
        names.push(name)
      }
    }

    const branches: VersionLogBranch[] = []
    for (let index = aState.order.length - 1; index >= 0; index -= 1) {
      const tip = aState.order[index]!
      if (line.has(tip.cid) || (childCount.get(tip.cid) ?? 0) > 0) {
        continue
      }

      let commits = 0
      let exclusiveCommits = 0
      let exclusiveEnded = false
      let fromMs = tip.atMs
      let toMs = tip.atMs
      let snapshots = 0
      let forkParent: string | null = null
      const tags: string[] = []

      let current: VersionLogCommit = tip
      for (;;) {
        commits += 1
        if (current.atMs < fromMs) {
          fromMs = current.atMs
        }
        if (current.atMs > toMs) {
          toMs = current.atMs
        }
        if (current.type === "snapshot") {
          snapshots += 1
        }
        const tagNames = tagsByCid.get(current.cid)
        if (tagNames !== undefined) {
          tags.push(...tagNames)
        }
        if (!exclusiveEnded && (childCount.get(current.cid) ?? 0) <= 1) {
          exclusiveCommits += 1
        } else {
          exclusiveEnded = true
        }

        if (current.parent === null) {
          break // graft/cut root — forkParent stays null (B3)
        }
        const parent = aState.commits.get(current.parent)
        if (parent === undefined) {
          break // missing parent = load-cut boundary; behaves like a root
        }
        if (line.has(parent.cid)) {
          forkParent = parent.cid
          break
        }
        current = parent
      }

      branches.push({ tip: tip.cid, forkParent, commits, exclusiveCommits, fromMs, toMs, snapshots, tags })
    }

    return branches
  }

  /** Persist commits one line at a time, mutating in-memory state only AFTER each successful
   *  write — an I/O failure mid-batch leaves exactly the persisted prefix in memory (the same
   *  prefix semantics as S3), and a reload agrees with it. */
  private async writeLines(aDir: string, aState: LogState, aCommits: readonly VersionLogCommit[], aLines: readonly string[]): Promise<void> {
    await mkdir(aDir, { recursive: true })

    for (const [index, line] of aLines.entries()) {
      let segment = aState.segments[aState.segments.length - 1]
      if (segment === undefined || segment.bytes >= this.segmentMaxBytes) {
        const nextIndex = segment === undefined ? 1 : segmentIndex(segment.name) + 1
        segment = { name: segmentFileName(nextIndex), bytes: 0 }
        aState.segments.push(segment)
        aState.tailNeedsNewline = false
      }

      const prefix = aState.tailNeedsNewline ? "\n" : ""
      await appendFile(join(aDir, segment.name), prefix + line, "utf8")
      segment.bytes += Buffer.byteLength(prefix + line, "utf8")
      aState.tailNeedsNewline = false

      const commit = aCommits[index]!
      aState.commits.set(commit.cid, commit)
      aState.order.push(commit)
      aState.nextSeq = commit.seq + 1
    }
  }

  private async writeRefs(aDir: string, aState: LogState): Promise<void> {
    await mkdir(aDir, { recursive: true })
    const payload = {
      schemaVersion: REFS_SCHEMA_VERSION,
      main: aState.refs.main,
      head: aState.refs.head,
      tags: aState.refs.tags,
    }
    const filePath = join(aDir, VERSION_LOG_REFS_FILE_NAME)
    const tempFilePath = join(aDir, `.${VERSION_LOG_REFS_FILE_NAME}.tmp-${randomUUID()}`)

    try {
      await writeFile(tempFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
      await rename(tempFilePath, filePath)
    } finally {
      await rm(tempFilePath, { force: true }).catch(() => undefined)
    }
  }

  // --- load + tolerant repair (S6/S7) -------------------------------------------------------

  private async loadState(aDir: string): Promise<LogState> {
    const state: LogState = {
      commits: new Map(),
      order: [],
      nextSeq: 1,
      refs: { main: null, head: null, tags: {} },
      segments: [],
      tailNeedsNewline: false,
    }

    let entries: Dirent[]
    try {
      entries = await readdir(aDir, { withFileTypes: true })
    } catch {
      return state
    }

    const segmentNames = entries
      .filter((aEntry) => aEntry.isFile() && SEGMENT_FILE_PATTERN.test(aEntry.name))
      .map((aEntry) => aEntry.name)
      .sort((aLeft, aRight) => segmentIndex(aLeft) - segmentIndex(aRight))

    let corrupted = false
    for (const [nameIndex, name] of segmentNames.entries()) {
      if (corrupted) {
        // Everything after a corruption point is cut (S7): parents may dangle otherwise.
        await this.moveAside(aDir, name, null)
        continue
      }

      const filePath = join(aDir, name)
      let buffer: Buffer
      try {
        buffer = Buffer.from(await readFile(filePath))
      } catch {
        corrupted = true
        continue
      }

      const lines = splitSegmentLines(buffer)
      const segment: SegmentState = { name, bytes: buffer.length }
      state.segments.push(segment)
      state.tailNeedsNewline = false

      for (const [lineIndex, line] of lines.entries()) {
        if (line.text === "") {
          continue
        }

        let commit: VersionLogCommit | null = null
        try {
          const parsed = JSON.parse(line.text) as unknown
          if (isStoredCommit(parsed)) {
            commit = { ...parsed, payload: (parsed as { payload?: unknown }).payload ?? null }
          }
        } catch {
          // fall through — handled as corruption below
        }

        const duplicate = commit !== null && state.commits.has(commit.cid)
        if (duplicate) {
          // A crash between a GC rewrite and old-segment deletion may leave the same commit in
          // two files; the first occurrence wins, the line is ignored.
          if (!line.terminated) {
            state.tailNeedsNewline = true
          }
          continue
        }

        // S3 re-checked on load: a non-null parent must be present (null = a root, possibly a
        // GC graft — valid anywhere in a stored log, unlike on append) and seq strictly
        // increasing (S4) — a violation means corruption. The seq rule is also what cleanly
        // cuts a stale pre-GC segment surviving next to the consolidated one after a crash.
        const chainOk =
          commit !== null &&
          (commit.parent === null || state.commits.has(commit.parent)) &&
          (state.order.length === 0 || commit.seq > state.order[state.order.length - 1]!.seq)

        if (commit !== null && chainOk) {
          state.commits.set(commit.cid, commit)
          state.order.push(commit)
          state.nextSeq = commit.seq + 1
          if (!line.terminated) {
            state.tailNeedsNewline = true
          }
          continue
        }

        // Corruption. Torn tail (S6) = the very last line of the very last segment; anything
        // else is a mid-log defect (S7) — cut here, preserve the remainder in .broken-<ts>.
        const isLastSegment = nameIndex === segmentNames.length - 1
        const isLastLine = lineIndex === lines.length - 1
        if (isLastSegment && isLastLine && !line.terminated) {
          console.warn(`[version-log] Torn tail truncated: ${name} at byte ${line.start}`)
        } else {
          console.error(`[version-log] Corrupt entry in ${name} at byte ${line.start}; log truncated, remainder preserved`)
        }

        await this.moveAside(aDir, name, buffer.subarray(line.start))
        await truncate(filePath, line.start).catch(() => undefined)
        segment.bytes = line.start
        corrupted = true
        break
      }
    }

    const repaired = await this.loadRefs(aDir, state)
    if (repaired) {
      // Persist the repair immediately: a re-derived ref must not drift on the NEXT reload when
      // "newest survivor" has moved on (found by the VL1.3 fuzz, seed 1042).
      await this.writeRefs(aDir, state)
    }
    return state
  }

  /** Preserve cut bytes (or a whole later segment when aRemainder is null) as *.broken-<ts>. */
  private async moveAside(aDir: string, aSegmentName: string, aRemainder: Buffer | null): Promise<void> {
    const brokenPath = join(aDir, `${aSegmentName}.broken-${formatFileTimestamp(new Date())}`)

    try {
      if (aRemainder === null) {
        await rename(join(aDir, aSegmentName), brokenPath)
      } else if (aRemainder.length > 0) {
        await writeFile(brokenPath, aRemainder)
      }
    } catch {
      // Preservation is best-effort; the truncate below still repairs the live log.
    }
  }

  /** Returns true when the loaded refs had to be repaired (S7) and must be re-persisted. */
  private async loadRefs(aDir: string, aState: LogState): Promise<boolean> {
    let text: string | null
    try {
      text = await readFile(join(aDir, VERSION_LOG_REFS_FILE_NAME), "utf8")
    } catch {
      // No refs.json = refs were never written — main/head stay null. Deliberately-null refs
      // (commits appended without advanceMain) must survive a reload unchanged; inventing
      // "newest" here is only justified when a refs FILE existed but its content was lost.
      return false
    }

    let parsed: unknown = null
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      // Unreadable content — best-effort derived defaults below.
    }

    const newest = aState.order.length === 0 ? null : aState.order[aState.order.length - 1]!.cid
    let repaired = false
    const resolveRef = (aValue: unknown): string | null => {
      if (typeof aValue === "string" && aState.commits.has(aValue)) {
        return aValue
      }
      if (aValue === null) {
        return null
      }
      // Unknown/cut cid (S7): fall back to the newest surviving commit.
      repaired = true
      return newest
    }

    if (isRecordValue(parsed) && parsed.schemaVersion === REFS_SCHEMA_VERSION) {
      aState.refs.main = resolveRef(parsed.main)
      aState.refs.head = resolveRef(parsed.head)
      if (isRecordValue(parsed.tags)) {
        for (const [name, cid] of Object.entries(parsed.tags)) {
          if (isValidTagName(name) && typeof cid === "string" && aState.commits.has(cid)) {
            aState.refs.tags[name] = cid
          } else {
            repaired = true
          }
        }
      }
      return repaired
    }

    aState.refs.main = newest
    aState.refs.head = newest
    return true
  }
}

export const createVersionLogStore = (aOptions: VersionLogStoreOptions = {}): VersionLogStore => {
  return new VersionLogStoreImpl(aOptions)
}
