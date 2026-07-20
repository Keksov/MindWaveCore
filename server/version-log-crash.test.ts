// VL1.2 (plan docs/undo-versioned-log): the S6 crash harness — an EXHAUSTIVE byte sweep, not a
// sampling. A golden log is built once; then for EVERY byte length T of the last segment the
// harness materializes a copy truncated to T (the on-disk state an interrupted write can leave),
// reopens the store and asserts the spec: the surviving state is exactly the longest valid
// prefix, refs are repaired (S7 rules), a follow-up append continues the log, and after a
// reload no garbage sits between records.
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import {
  createVersionLogStore,
  type VersionLogCommit,
  type VersionLogCommitInput,
} from "./version-log-store"

const fixtureRoots: string[] = []
const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "version-log-crash-"))
  fixtureRoots.push(root)
  return root
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(fixtureRoots.splice(0).map((aRoot) => rm(aRoot, { recursive: true, force: true }).catch(() => undefined)))
})

const delta = (aCid: string, aParent: string | null, aAtMs: number): VersionLogCommitInput => {
  return { cid: aCid, parent: aParent, type: "delta", atMs: aAtMs, payload: { v: aCid } }
}

interface GoldenLog {
  readonly commits: readonly VersionLogCommit[]
  readonly segmentNames: readonly string[]
  readonly segmentBuffers: ReadonlyMap<string, Buffer>
  readonly refsBuffer: Buffer
}

/** Chain r->a->b->c->d, main=d (advanceMain), head=b, tag pin=c. */
const buildGolden = async (aSegmentMaxBytes?: number): Promise<GoldenLog> => {
  const store = createVersionLogStore(aSegmentMaxBytes === undefined ? {} : { segmentMaxBytes: aSegmentMaxBytes })
  const dir = join(await makeRoot(), "undo-log")

  await store.append(
    dir,
    [delta("r", null, 1), delta("a", "r", 2), delta("b", "a", 3), delta("c", "b", 4), delta("d", "c", 5)],
    { advanceMain: true },
  )
  await store.putRefs(dir, { head: "b", tags: { pin: "c" } })

  const commits = await store.listCommits(dir)
  const segmentNames = (await readdir(dir)).filter((aName) => aName.endsWith(".jsonl")).sort()
  const segmentBuffers = new Map<string, Buffer>()
  for (const name of segmentNames) {
    segmentBuffers.set(name, Buffer.from(await readFile(join(dir, name))))
  }
  const refsBuffer = Buffer.from(await readFile(join(dir, "refs.json")))

  return { commits, segmentNames, segmentBuffers, refsBuffer }
}

interface LineRange {
  /** Byte offset of the line start within its segment. */
  readonly start: number
  /** Byte offset just past the JSON text (the '\n' position). */
  readonly textEnd: number
}

const lineRanges = (aBuffer: Buffer): LineRange[] => {
  const ranges: LineRange[] = []
  let start = 0
  while (start < aBuffer.length) {
    const newline = aBuffer.indexOf(0x0a, start)
    if (newline === -1) {
      ranges.push({ start, textEnd: aBuffer.length })
      break
    }
    ranges.push({ start, textEnd: newline })
    start = newline + 1
  }
  return ranges
}

/** Every non-empty line of every segment must parse — no garbage between records (S6). */
const assertSegmentsParse = async (aDir: string): Promise<void> => {
  const names = (await readdir(aDir)).filter((aName) => aName.endsWith(".jsonl")).sort()
  for (const name of names) {
    const lines = (await readFile(join(aDir, name), "utf8")).split("\n")
    for (const line of lines) {
      if (line !== "") {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    }
  }
}

const runSweep = async (aGolden: GoldenLog): Promise<void> => {
  const lastSegment = aGolden.segmentNames[aGolden.segmentNames.length - 1]!
  const lastBuffer = aGolden.segmentBuffers.get(lastSegment)!
  const ranges = lineRanges(lastBuffer)

  // Commits are distributed over segments in order; the last segment holds the final K lines.
  const earlierCount = aGolden.commits.length - ranges.length
  const root = await makeRoot()

  for (let cut = 0; cut <= lastBuffer.length; cut += 1) {
    const dir = join(root, `t${cut}`, "undo-log")
    await mkdir(dir, { recursive: true })
    for (const name of aGolden.segmentNames.slice(0, -1)) {
      await writeFile(join(dir, name), aGolden.segmentBuffers.get(name)!)
    }
    await writeFile(join(dir, lastSegment), lastBuffer.subarray(0, cut))
    await writeFile(join(dir, "refs.json"), aGolden.refsBuffer)

    // Expected survivors: earlier segments in full + every last-segment line whose JSON text is
    // fully inside the cut (a line missing only its '\n' still parses and is kept).
    const keptInLast = ranges.filter((aRange) => cut >= aRange.textEnd).length
    const survivors = aGolden.commits.slice(0, earlierCount + keptInLast)
    const newest = survivors.length === 0 ? null : survivors[survivors.length - 1]!.cid
    const surviving = new Set(survivors.map((aCommit) => aCommit.cid))

    const store = createVersionLogStore()
    const listed = await store.listCommits(dir)
    expect(listed.map((aCommit) => aCommit.cid)).toEqual(survivors.map((aCommit) => aCommit.cid))

    // S6: a cut inside the LAST line loses at most that one commit.
    const lastRange = ranges[ranges.length - 1]
    if (lastRange !== undefined && cut > lastRange.start) {
      expect(listed.length).toBeGreaterThanOrEqual(aGolden.commits.length - 1)
    }

    // S7 ref repair: a surviving ref target stays; a cut one falls back to the newest survivor;
    // a tag on a cut commit is dropped.
    const refs = await store.getRefs(dir)
    expect(refs.main).toBe(surviving.has("d") ? "d" : newest)
    expect(refs.head).toBe(surviving.has("b") ? "b" : newest)
    expect(refs.tags).toEqual(surviving.has("c") ? { pin: "c" } : {})

    // The log continues: append chained to the newest survivor (a fresh root when empty).
    const nextCid = `x${cut}`
    const result = await store.append(dir, [delta(nextCid, newest, 100 + cut)], { advanceMain: true })
    expect(result.appended).toBe(1)

    store.forget(dir)
    const reloaded = await store.listCommits(dir)
    expect(reloaded.map((aCommit) => aCommit.cid)).toEqual([...survivors.map((aCommit) => aCommit.cid), nextCid])
    const reloadedRefs = await store.getRefs(dir)
    expect(reloadedRefs.main).toBe(nextCid)
    expect(reloadedRefs.head).toBe(surviving.has("b") ? "b" : newest)

    await assertSegmentsParse(dir)
  }
}

describe("S6 crash harness — exhaustive byte sweep of the last segment", () => {
  test("single-segment log: every truncation point recovers to the longest valid prefix", async () => {
    const golden = await buildGolden()
    expect(golden.segmentNames.length).toBe(1)
    await runSweep(golden)
  }, 120_000)

  test("multi-segment log: earlier segments stay intact while the last one is swept", async () => {
    const golden = await buildGolden(150)
    expect(golden.segmentNames.length).toBeGreaterThanOrEqual(2)
    await runSweep(golden)
  }, 120_000)
})
