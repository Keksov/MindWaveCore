// VL1.3 (plan docs/undo-versioned-log): the fuzz suite — a deterministic PRNG drives random
// operation sequences against the real store AND a pure in-memory oracle that encodes the spec;
// after every operation the full observable state (commits + refs + append results) must match.
// Crash-truncate operations assert the S6 prefix property, then the oracle adopts the surviving
// state. A failing seed prints in the test name — rerun is exact.
//
// Covered here: S1–S5, S7 (agreement after repair), S11 (call-order serialization), S12.
// The gc operation joined the pool in VL2.1; undo-orphan-branches (B8) adds the deleteBranch
// operation plus a listBranches comparison and an oracle-independent B1–B4 partition check
// after EVERY operation.
import { mkdtemp, readdir, readFile, stat, truncate } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import {
  createVersionLogStore,
  isVersionLogError,
  type VersionLogAppendResult,
  type VersionLogBranch,
  type VersionLogCommit,
  type VersionLogCommitInput,
  type VersionLogGcPolicy,
  type VersionLogRefs,
  type VersionLogRefsPatch,
  type VersionLogStore,
} from "./version-log-store"

const fixtureRoots: string[] = []
const makeLogDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "version-log-fuzz-"))
  fixtureRoots.push(root)
  return join(root, "undo-log")
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(fixtureRoots.splice(0).map((aRoot) => rm(aRoot, { recursive: true, force: true }).catch(() => undefined)))
})

// --- deterministic PRNG ---------------------------------------------------------------------

const mulberry32 = (aSeed: number): (() => number) => {
  let state = aSeed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// --- the oracle: a pure re-statement of the spec --------------------------------------------

interface OracleError {
  readonly status: number
}

class Oracle {
  public commits: VersionLogCommit[] = []
  public byCid = new Map<string, VersionLogCommit>()
  public nextSeq = 1
  public refs: { main: string | null; head: string | null; tags: Record<string, string> } = {
    main: null,
    head: null,
    tags: {},
  }

  public append(aInputs: readonly VersionLogCommitInput[], aAdvanceMain: boolean): VersionLogAppendResult {
    const knownInBatch = new Set<string>()
    let appended = 0
    let skipped = 0
    let rejectedFrom: string | null = null
    let lastPresentCid: string | null = null

    for (const input of aInputs) {
      if (this.byCid.has(input.cid) || knownInBatch.has(input.cid)) {
        skipped += 1
        lastPresentCid = input.cid
        continue
      }

      const parentKnown =
        input.parent === null
          ? this.byCid.size === 0 && appended === 0
          : this.byCid.has(input.parent) || knownInBatch.has(input.parent)
      if (!parentKnown) {
        rejectedFrom = input.cid
        break
      }

      const commit: VersionLogCommit = {
        cid: input.cid,
        parent: input.parent,
        type: input.type,
        atMs: input.atMs,
        payload: input.payload ?? null,
        seq: this.nextSeq,
      }
      this.nextSeq += 1
      this.commits.push(commit)
      this.byCid.set(commit.cid, commit)
      knownInBatch.add(commit.cid)
      appended += 1
      lastPresentCid = input.cid
    }

    if (aAdvanceMain && lastPresentCid !== null) {
      this.refs.main = lastPresentCid
    }

    return {
      appended,
      skipped,
      rejectedFrom,
      rejectedReason: rejectedFrom === null ? null : "unknown-parent",
      refs: this.snapshotRefs(),
    }
  }

  public putRefs(aPatch: VersionLogRefsPatch): VersionLogRefs {
    const assertKnown = (aCid: string | null | undefined): void => {
      if (typeof aCid === "string" && !this.byCid.has(aCid)) {
        throw { status: 404 } satisfies OracleError
      }
    }
    assertKnown(aPatch.main)
    assertKnown(aPatch.head)

    const tagPatch = aPatch.tags ?? {}
    for (const [name, cid] of Object.entries(tagPatch)) {
      const validName =
        name.length > 0 && name.length <= 64 && [...name].every((aChar) => aChar.charCodeAt(0) >= 0x20 && aChar.trim() !== "")
      if (!validName) {
        throw { status: 400 } satisfies OracleError
      }
      assertKnown(cid)
    }

    if (aPatch.main !== undefined) {
      this.refs.main = aPatch.main
    }
    if (aPatch.head !== undefined) {
      this.refs.head = aPatch.head
    }
    for (const [name, cid] of Object.entries(tagPatch)) {
      if (cid === null) {
        delete this.refs.tags[name]
      } else {
        this.refs.tags[name] = cid
      }
    }

    return this.snapshotRefs()
  }

  public clear(): void {
    this.commits = []
    this.byCid = new Map()
    this.nextSeq = 1
    this.refs = { main: null, head: null, tags: {} }
  }

  /** S8, mirrored: orphans first, oldest fitting anchor, protected chains, grafting. */
  public gc(aPolicy: VersionLogGcPolicy): void {
    if (this.commits.length === 0) {
      return
    }

    const reachable = new Set<string>()
    for (const root of [this.refs.main, this.refs.head, ...Object.values(this.refs.tags)]) {
      let cid = root
      while (cid !== null && !reachable.has(cid)) {
        const commit = this.byCid.get(cid)
        if (commit === undefined) {
          break
        }
        reachable.add(cid)
        cid = commit.parent
      }
    }

    const mainChain: VersionLogCommit[] = []
    for (let cid = this.refs.main; cid !== null; ) {
      const commit = this.byCid.get(cid)
      if (commit === undefined) {
        break
      }
      mainChain.push(commit)
      cid = commit.parent
    }
    const anchors = mainChain.filter((aCommit) => aCommit.type === "snapshot")

    const keepFor = (aAnchor: VersionLogCommit): Set<string> => {
      const keep = new Set<string>()
      for (let cid = this.refs.main; cid !== null; ) {
        const commit = this.byCid.get(cid)!
        keep.add(cid)
        if (cid === aAnchor.cid) {
          break
        }
        cid = commit.parent
      }
      for (const root of [this.refs.head, ...Object.values(this.refs.tags)]) {
        for (let cid = root; cid !== null && !keep.has(cid); ) {
          const commit = this.byCid.get(cid)
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

    const graft = (aCommit: VersionLogCommit, aKeep: Set<string>): VersionLogCommit => {
      return aCommit.parent !== null && !aKeep.has(aCommit.parent) ? { ...aCommit, parent: null } : aCommit
    }

    const fits = (aKeep: Set<string>, aAnchor: VersionLogCommit): boolean => {
      if (aPolicy.maxCommits !== undefined && aPolicy.maxCommits > 0 && aKeep.size > aPolicy.maxCommits) {
        return false
      }
      if (aPolicy.maxAgeMs !== undefined && aPolicy.maxAgeMs > 0 && aAnchor.atMs < (aPolicy.nowMs ?? 0) - aPolicy.maxAgeMs) {
        return false
      }
      if (aPolicy.maxBytes !== undefined && aPolicy.maxBytes > 0) {
        let bytes = 0
        for (const cid of aKeep) {
          bytes += Buffer.byteLength(`${JSON.stringify(graft(this.byCid.get(cid)!, aKeep))}\n`, "utf8")
        }
        if (bytes > aPolicy.maxBytes) {
          return false
        }
      }
      return true
    }

    let keepSet: Set<string> | undefined
    if (anchors.length === 0) {
      keepSet = reachable
    } else {
      for (let index = anchors.length - 1; index >= 0; index -= 1) {
        const candidate = anchors[index]!
        const candidateKeep = keepFor(candidate)
        if (fits(candidateKeep, candidate)) {
          keepSet = candidateKeep
          break
        }
      }
      keepSet ??= keepFor(anchors[0]!)
    }

    const kept = this.commits.filter((aCommit) => keepSet.has(aCommit.cid))
    if (kept.length === this.commits.length) {
      return
    }

    this.commits = kept.map((aCommit) => graft(aCommit, keepSet))
    this.byCid = new Map(this.commits.map((aCommit) => [aCommit.cid, aCommit]))
    // The store reloads after a GC rewrite, so its nextSeq re-derives from the kept maximum.
    this.nextSeq = this.commits.length === 0 ? 1 : this.commits[this.commits.length - 1]!.seq + 1
  }

  /** B1..B4, mirrored: flat tips of {main, head}-unreachable chains, newest tip first. */
  public listBranches(): VersionLogBranch[] {
    const line = new Set<string>()
    for (const root of [this.refs.main, this.refs.head]) {
      let cid = root
      while (cid !== null && !line.has(cid)) {
        const commit = this.byCid.get(cid)
        if (commit === undefined) {
          break
        }
        line.add(cid)
        cid = commit.parent
      }
    }

    const childCount = new Map<string, number>()
    for (const commit of this.commits) {
      if (commit.parent !== null) {
        childCount.set(commit.parent, (childCount.get(commit.parent) ?? 0) + 1)
      }
    }
    const tagsByCid = new Map<string, string[]>()
    for (const [name, cid] of Object.entries(this.refs.tags)) {
      const names = tagsByCid.get(cid)
      if (names === undefined) {
        tagsByCid.set(cid, [name])
      } else {
        names.push(name)
      }
    }

    const branches: VersionLogBranch[] = []
    for (let index = this.commits.length - 1; index >= 0; index -= 1) {
      const tip = this.commits[index]!
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
        fromMs = Math.min(fromMs, current.atMs)
        toMs = Math.max(toMs, current.atMs)
        if (current.type === "snapshot") {
          snapshots += 1
        }
        tags.push(...(tagsByCid.get(current.cid) ?? []))
        if (!exclusiveEnded && (childCount.get(current.cid) ?? 0) <= 1) {
          exclusiveCommits += 1
        } else {
          exclusiveEnded = true
        }
        if (current.parent === null) {
          break
        }
        const parent = this.byCid.get(current.parent)
        if (parent === undefined) {
          break
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

  /** B5/B6, mirrored: exclusive-suffix removal with the store's 404/409 semantics. */
  public deleteBranch(aTip: string): number {
    const tip = this.byCid.get(aTip)
    if (tip === undefined) {
      throw { status: 404 } satisfies OracleError
    }

    const line = new Set<string>()
    for (const root of [this.refs.main, this.refs.head]) {
      let cid = root
      while (cid !== null && !line.has(cid)) {
        const commit = this.byCid.get(cid)
        if (commit === undefined) {
          break
        }
        line.add(cid)
        cid = commit.parent
      }
    }
    const childCount = new Map<string, number>()
    for (const commit of this.commits) {
      if (commit.parent !== null) {
        childCount.set(commit.parent, (childCount.get(commit.parent) ?? 0) + 1)
      }
    }
    if (line.has(tip.cid) || (childCount.get(tip.cid) ?? 0) > 0) {
      throw { status: 409 } satisfies OracleError
    }

    const tagged = new Set(Object.values(this.refs.tags))
    const doomed = new Set<string>()
    let current: VersionLogCommit = tip
    for (;;) {
      if (tagged.has(current.cid)) {
        throw { status: 409 } satisfies OracleError
      }
      doomed.add(current.cid)
      if (current.parent === null) {
        break
      }
      const parent = this.byCid.get(current.parent)
      if (parent === undefined || line.has(parent.cid) || (childCount.get(parent.cid) ?? 0) > 1) {
        break
      }
      current = parent
    }

    this.commits = this.commits.filter((aCommit) => !doomed.has(aCommit.cid))
    this.byCid = new Map(this.commits.map((aCommit) => [aCommit.cid, aCommit]))
    // The store reloads after the rewrite, so its nextSeq re-derives from the kept maximum.
    this.nextSeq = this.commits.length === 0 ? 1 : this.commits[this.commits.length - 1]!.seq + 1
    return doomed.size
  }

  /** After a crash-truncate the oracle adopts the store's surviving state (S6 keeps it a prefix). */
  public adopt(aCommits: readonly VersionLogCommit[], aRefs: VersionLogRefs): void {
    this.commits = [...aCommits]
    this.byCid = new Map(aCommits.map((aCommit) => [aCommit.cid, aCommit]))
    // An emptied log restarts seq at 1 on reload — exactly what loadState derives from disk.
    this.nextSeq = aCommits.length === 0 ? 1 : aCommits[aCommits.length - 1]!.seq + 1
    this.refs = { main: aRefs.main, head: aRefs.head, tags: { ...aRefs.tags } }
  }

  public snapshotRefs(): VersionLogRefs {
    return { main: this.refs.main, head: this.refs.head, tags: { ...this.refs.tags } }
  }
}

// --- structural invariants (checked on the STORE state, independent of the oracle) ----------

const assertStructuralInvariants = (aCommits: readonly VersionLogCommit[], aRefs: VersionLogRefs): void => {
  const seen = new Set<string>()
  let previousSeq = 0
  for (const commit of aCommits) {
    if (commit.seq <= previousSeq) {
      throw new Error(`S4 violated: seq ${commit.seq} after ${previousSeq}`)
    }
    previousSeq = commit.seq
    // A null parent is a root: the original one or a GC graft (S8е) — valid anywhere in a
    // stored log. Appending a second root is still rejected, but that is append-level S3.
    if (commit.parent !== null && !seen.has(commit.parent)) {
      throw new Error(`S3 violated: unknown parent ${commit.parent} of ${commit.cid}`)
    }
    if (seen.has(commit.cid)) {
      throw new Error(`S2 violated: duplicate cid ${commit.cid}`)
    }
    seen.add(commit.cid)
  }

  for (const [name, cid] of [["main", aRefs.main], ["head", aRefs.head], ...Object.entries(aRefs.tags)] as const) {
    if (cid !== null && !seen.has(cid)) {
      throw new Error(`S5 violated: ref ${name} points at unknown ${cid}`)
    }
  }
}

/** B1–B4, independent of the oracle: the branches list partitions the store's own state. */
const assertBranchInvariants = (
  aCommits: readonly VersionLogCommit[],
  aRefs: VersionLogRefs,
  aBranches: readonly VersionLogBranch[],
): void => {
  const byCid = new Map(aCommits.map((aCommit) => [aCommit.cid, aCommit]))
  const childCount = new Map<string, number>()
  for (const commit of aCommits) {
    if (commit.parent !== null) {
      childCount.set(commit.parent, (childCount.get(commit.parent) ?? 0) + 1)
    }
  }
  const line = new Set<string>()
  for (const root of [aRefs.main, aRefs.head]) {
    let cid = root
    while (cid !== null && !line.has(cid)) {
      const commit = byCid.get(cid)
      if (commit === undefined) {
        break
      }
      line.add(cid)
      cid = commit.parent
    }
  }

  const tips = new Set<string>()
  const covered = new Set<string>()
  for (const branch of aBranches) {
    if (tips.has(branch.tip)) {
      throw new Error(`B2 violated: duplicate tip ${branch.tip}`)
    }
    tips.add(branch.tip)
    if ((childCount.get(branch.tip) ?? 0) > 0) {
      throw new Error(`B2 violated: tip ${branch.tip} has children`)
    }
    if (line.has(branch.tip)) {
      throw new Error(`B1 violated: line commit ${branch.tip} listed as a tip`)
    }

    let cid: string | null = branch.tip
    let count = 0
    let fork: string | null = null
    while (cid !== null) {
      const commit = byCid.get(cid)
      if (commit === undefined) {
        break
      }
      if (line.has(cid)) {
        fork = cid
        break
      }
      covered.add(cid)
      count += 1
      cid = commit.parent
    }
    if (count !== branch.commits) {
      throw new Error(`B4 violated: tip ${branch.tip} chain length ${count} != reported ${branch.commits}`)
    }
    if (fork !== branch.forkParent) {
      throw new Error(`B3 violated: tip ${branch.tip} fork ${fork} != reported ${branch.forkParent}`)
    }
  }

  for (const commit of aCommits) {
    if (!line.has(commit.cid) && !covered.has(commit.cid)) {
      throw new Error(`B1 violated: orphan ${commit.cid} not covered by any branch`)
    }
    if (!line.has(commit.cid) && (childCount.get(commit.cid) ?? 0) === 0 && !tips.has(commit.cid)) {
      throw new Error(`B2 violated: childless orphan ${commit.cid} missing from the tips`)
    }
  }
}

// --- fuzz driver ----------------------------------------------------------------------------

interface FuzzContext {
  readonly store: VersionLogStore
  readonly dir: string
  readonly oracle: Oracle
  readonly random: () => number
  cidCounter: number
}

const pick = <T>(aRandom: () => number, aItems: readonly T[]): T => {
  return aItems[Math.floor(aRandom() * aItems.length)]!
}

const randomExistingCid = (aContext: FuzzContext): string | null => {
  const commits = aContext.oracle.commits
  return commits.length === 0 ? null : pick(aContext.random, commits).cid
}

const buildAppendBatch = (aContext: FuzzContext): VersionLogCommitInput[] => {
  const { random, oracle } = aContext
  const size = 1 + Math.floor(random() * 3)
  const batch: VersionLogCommitInput[] = []
  const batchCids: string[] = []

  for (let index = 0; index < size; index += 1) {
    const roll = random()
    let cid: string
    let parent: string | null

    if (roll < 0.1 && oracle.commits.length > 0) {
      // duplicate of an existing commit (S2) — fields other than cid are irrelevant
      cid = randomExistingCid(aContext)!
      parent = randomExistingCid(aContext)
    } else if (roll < 0.15) {
      cid = `c${(aContext.cidCounter += 1)}`
      parent = `ghost-${Math.floor(random() * 1000)}`
    } else if (roll < 0.18) {
      cid = `c${(aContext.cidCounter += 1)}`
      parent = null // a root — valid only on an empty log (S3)
    } else {
      cid = `c${(aContext.cidCounter += 1)}`
      const candidates = [...batchCids]
      const existing = randomExistingCid(aContext)
      if (existing !== null) {
        candidates.push(existing, existing) // bias towards persisted parents
      }
      parent = candidates.length === 0 ? null : pick(random, candidates)
    }

    const typeRoll = random()
    batch.push({
      cid,
      parent,
      type: typeRoll < 0.8 ? "delta" : typeRoll < 0.95 ? "snapshot" : "meta",
      atMs: 1_000 + aContext.cidCounter,
      payload: random() < 0.1 ? undefined : { n: Math.floor(random() * 1_000) },
    })
    batchCids.push(cid)
  }

  return batch
}

const buildRefsPatch = (aContext: FuzzContext): VersionLogRefsPatch => {
  const { random } = aContext
  const patch: { main?: string | null; head?: string | null; tags?: Record<string, string | null> } = {}
  const target = (): string | null => {
    if (random() < 0.08) {
      return `ghost-${Math.floor(random() * 1000)}` // both sides must reject with 404
    }
    return random() < 0.15 ? null : randomExistingCid(aContext)
  }

  if (random() < 0.5) {
    patch.main = target()
  }
  if (random() < 0.6) {
    patch.head = target()
  }
  if (random() < 0.5) {
    const name = random() < 0.05 ? "bad name" : pick(random, ["pin", "wip", "метка", "v1"])
    const cid = random() < 0.25 ? null : target()
    patch.tags = { [name]: cid }
  }

  return patch
}

const compareStates = async (aContext: FuzzContext, aWhere: string): Promise<void> => {
  const commits = await aContext.store.listCommits(aContext.dir)
  const refs = await aContext.store.getRefs(aContext.dir)
  assertStructuralInvariants(commits, refs)

  const expected = { commits: aContext.oracle.commits, refs: aContext.oracle.snapshotRefs() }
  const actual = { commits: [...commits], refs }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${aWhere}: store diverged from oracle\nstore:  ${JSON.stringify(actual)}\noracle: ${JSON.stringify(expected)}`,
    )
  }

  // B8: the branches view agrees with the oracle AND partitions the store state on its own.
  const branches = await aContext.store.listBranches(aContext.dir)
  assertBranchInvariants(commits, refs, branches)
  const expectedBranches = aContext.oracle.listBranches()
  if (JSON.stringify(branches) !== JSON.stringify(expectedBranches)) {
    throw new Error(
      `${aWhere}: listBranches diverged\nstore:  ${JSON.stringify(branches)}\noracle: ${JSON.stringify(expectedBranches)}`,
    )
  }
}

const runFuzzSeed = async (aSeed: number, aOperations: number): Promise<void> => {
  const context: FuzzContext = {
    store: createVersionLogStore({ segmentMaxBytes: 700 }),
    dir: await makeLogDir(),
    oracle: new Oracle(),
    random: mulberry32(aSeed),
    cidCounter: 0,
  }

  for (let step = 0; step < aOperations; step += 1) {
    const where = `seed=${aSeed} op#${step}`
    const roll = context.random()

    if (roll < 0.5) {
      const batch = buildAppendBatch(context)
      const advanceMain = context.random() < 0.8
      const actual = await context.store.append(context.dir, batch, { advanceMain })
      const expected = context.oracle.append(batch, advanceMain)
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${where}: append result diverged\nstore:  ${JSON.stringify(actual)}\noracle: ${JSON.stringify(expected)}`)
      }
    } else if (roll < 0.66) {
      const patch = buildRefsPatch(context)
      let actualStatus = 0
      let expectedStatus = 0
      try {
        await context.store.putRefs(context.dir, patch)
      } catch (error) {
        actualStatus = isVersionLogError(error) ? error.status : -1
      }
      try {
        context.oracle.putRefs(patch)
      } catch (error) {
        expectedStatus = (error as OracleError).status
      }
      if (actualStatus !== expectedStatus) {
        throw new Error(`${where}: putRefs status diverged (store ${actualStatus}, oracle ${expectedStatus}) patch=${JSON.stringify(patch)}`)
      }
    } else if (roll < 0.72) {
      context.store.forget(context.dir)
    } else if (roll < 0.8) {
      await crashTruncate(context, where)
    } else if (roll < 0.87) {
      const policy: VersionLogGcPolicy = {
        maxCommits: context.random() < 0.5 ? 1 + Math.floor(context.random() * 20) : 0,
        maxBytes: context.random() < 0.3 ? 300 + Math.floor(context.random() * 3000) : 0,
        maxAgeMs: context.random() < 0.3 ? 1 + Math.floor(context.random() * 200) : 0,
        nowMs: 1_000 + context.cidCounter,
      }
      await context.store.gc(context.dir, policy)
      context.oracle.gc(policy)
    } else if (roll < 0.9) {
      await context.store.clear(context.dir)
      context.oracle.clear()
    } else if (roll < 0.96) {
      // B8: delete a real branch tip most of the time, a random/ghost cid to exercise 404/409.
      const knownBranches = context.oracle.listBranches()
      const tip =
        context.random() < 0.85 && knownBranches.length > 0
          ? pick(context.random, knownBranches).tip
          : context.random() < 0.5
            ? randomExistingCid(context) ?? `ghost-${Math.floor(context.random() * 1000)}`
            : `ghost-${Math.floor(context.random() * 1000)}`
      let actualStatus = 0
      let actualDeleted = -1
      let expectedStatus = 0
      let expectedDeleted = -1
      try {
        actualDeleted = await context.store.deleteBranch(context.dir, tip)
      } catch (error) {
        actualStatus = isVersionLogError(error) ? error.status : -1
      }
      try {
        expectedDeleted = context.oracle.deleteBranch(tip)
      } catch (error) {
        expectedStatus = (error as OracleError).status
      }
      if (actualStatus !== expectedStatus || actualDeleted !== expectedDeleted) {
        throw new Error(
          `${where}: deleteBranch diverged (store ${actualDeleted}/${actualStatus}, oracle ${expectedDeleted}/${expectedStatus}) tip=${tip}`,
        )
      }
    } else {
      await verifyChainRead(context, where)
    }

    await compareStates(context, where)
  }
}

/** Chop 1..40 bytes off the last segment, reopen, assert the S6 prefix property, resync oracle. */
const crashTruncate = async (aContext: FuzzContext, aWhere: string): Promise<void> => {
  const names = (await readdir(aContext.dir).catch(() => [] as string[]))
    .filter((aName) => aName.endsWith(".jsonl"))
    .sort()
  const last = names[names.length - 1]
  if (last === undefined) {
    return
  }

  const filePath = join(aContext.dir, last)
  const size = (await stat(filePath)).size
  if (size === 0) {
    return
  }

  const cut = Math.max(0, size - (1 + Math.floor(aContext.random() * 40)))
  await truncate(filePath, cut)
  aContext.store.forget(aContext.dir)

  const commits = await aContext.store.listCommits(aContext.dir)
  const refs = await aContext.store.getRefs(aContext.dir)
  assertStructuralInvariants(commits, refs)

  // S6: the survivors are exactly a prefix of the oracle's history.
  for (const [index, commit] of commits.entries()) {
    if (JSON.stringify(commit) !== JSON.stringify(aContext.oracle.commits[index])) {
      throw new Error(`${aWhere}: crash survivors are not a history prefix at index ${index}`)
    }
  }
  if (commits.length > aContext.oracle.commits.length) {
    throw new Error(`${aWhere}: crash produced MORE commits than were ever appended`)
  }

  aContext.oracle.adopt(commits, refs)
}

const verifyChainRead = async (aContext: FuzzContext, aWhere: string): Promise<void> => {
  const from = aContext.random() < 0.4 ? "main" : aContext.random() < 0.5 ? "head" : randomExistingCid(aContext) ?? "main"
  const limit = 1 + Math.floor(aContext.random() * 5)
  const chain = await aContext.store.readChain(aContext.dir, { from, limit })

  const startCid = from === "main" ? aContext.oracle.refs.main : from === "head" ? aContext.oracle.refs.head : from
  const expected: VersionLogCommit[] = []
  let cid = startCid
  while (cid !== null && expected.length < limit) {
    const commit = aContext.oracle.byCid.get(cid)
    if (commit === undefined) {
      break
    }
    expected.push(commit)
    cid = commit.parent
  }

  if (JSON.stringify(chain.commits) !== JSON.stringify(expected)) {
    throw new Error(`${aWhere}: readChain diverged (from=${from}, limit=${limit})`)
  }
}

// --- suites ---------------------------------------------------------------------------------

describe("fuzz vs oracle (S1–S5, S7, S12; deterministic seeds)", () => {
  const SEEDS = Array.from({ length: 24 }, (_aValue, aIndex) => 1_000 + aIndex * 7)

  for (const seed of SEEDS) {
    test(`seed ${seed}: 220 mixed operations agree with the oracle`, async () => {
      await runFuzzSeed(seed, 220)
    }, 60_000)
  }
})

describe("concurrency (S11)", () => {
  test("a burst of concurrent operations equals the sequential call-order simulation", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    const oracle = new Oracle()

    const batches: VersionLogCommitInput[][] = []
    let previous: string | null = null
    for (let index = 0; index < 20; index += 1) {
      const cid = `c${index}`
      batches.push([{ cid, parent: previous, type: "delta", atMs: index, payload: { index } }])
      previous = cid
    }

    // Fire everything at once: SerialQueues must serialize per dir in call order (S11), so the
    // outcome is THE sequential application of the same calls.
    await Promise.all(batches.map((aBatch) => store.append(dir, aBatch, { advanceMain: true })))
    for (const batch of batches) {
      oracle.append(batch, true)
    }

    expect(await store.listCommits(dir)).toEqual(oracle.commits)
    expect(await store.getRefs(dir)).toEqual(oracle.snapshotRefs())

    // And the disk agrees after a reopen.
    store.forget(dir)
    expect(await store.listCommits(dir)).toEqual(oracle.commits)
  })
})
