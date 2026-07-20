// VL1.3 (plan docs/undo-versioned-log): the fuzz suite — a deterministic PRNG drives random
// operation sequences against the real store AND a pure in-memory oracle that encodes the spec;
// after every operation the full observable state (commits + refs + append results) must match.
// Crash-truncate operations assert the S6 prefix property, then the oracle adopts the surviving
// state. A failing seed prints in the test name — rerun is exact.
//
// Covered here: S1–S5, S7 (agreement after repair), S11 (call-order serialization), S12.
// The gc operation joins the pool in VL2.1.
import { mkdtemp, readdir, readFile, stat, truncate } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import {
  createVersionLogStore,
  isVersionLogError,
  type VersionLogAppendResult,
  type VersionLogCommit,
  type VersionLogCommitInput,
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
  for (const [index, commit] of aCommits.entries()) {
    if (commit.seq <= previousSeq) {
      throw new Error(`S4 violated: seq ${commit.seq} after ${previousSeq}`)
    }
    previousSeq = commit.seq
    if (commit.parent === null) {
      if (index !== 0) {
        throw new Error(`S3 violated: null parent at index ${index}`)
      }
    } else if (!seen.has(commit.parent)) {
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

    if (roll < 0.55) {
      const batch = buildAppendBatch(context)
      const advanceMain = context.random() < 0.8
      const actual = await context.store.append(context.dir, batch, { advanceMain })
      const expected = context.oracle.append(batch, advanceMain)
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${where}: append result diverged\nstore:  ${JSON.stringify(actual)}\noracle: ${JSON.stringify(expected)}`)
      }
    } else if (roll < 0.7) {
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
    } else if (roll < 0.8) {
      context.store.forget(context.dir)
    } else if (roll < 0.9) {
      await crashTruncate(context, where)
    } else if (roll < 0.95) {
      await context.store.clear(context.dir)
      context.oracle.clear()
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
