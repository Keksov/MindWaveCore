// VL2.1 (plan docs/undo-versioned-log): GC conformance — S8 guarantees one by one. The shared
// fixture is a main chain with several snapshot anchors plus orphaned side chains (the undo →
// new-commit "detached tail" shape from VL-D2), so every rule has something real to bite on.
import { mkdtemp, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import {
  createVersionLogStore,
  type VersionLogCommitInput,
  type VersionLogStore,
} from "./version-log-store"

const fixtureRoots: string[] = []
const makeLogDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "version-log-gc-"))
  fixtureRoots.push(root)
  return join(root, "undo-log")
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(fixtureRoots.splice(0).map((aRoot) => rm(aRoot, { recursive: true, force: true }).catch(() => undefined)))
})

const commit = (aCid: string, aParent: string | null, aType: "snapshot" | "delta", aAtMs: number): VersionLogCommitInput => {
  return { cid: aCid, parent: aParent, type: aType, atMs: aAtMs, payload: { v: aCid } }
}

/** Main chain s0→d1→s1→d2→s2→d3 (main=d3) + orphan branch o1→o2 hanging off d1. */
const seedAnchored = async (aStore: VersionLogStore, aDir: string): Promise<void> => {
  await aStore.append(
    aDir,
    [
      commit("s0", null, "snapshot", 100),
      commit("d1", "s0", "delta", 200),
      commit("s1", "d1", "snapshot", 300),
      commit("d2", "s1", "delta", 400),
      commit("s2", "d2", "snapshot", 500),
      commit("d3", "s2", "delta", 600),
    ],
    { advanceMain: true },
  )
  await aStore.append(aDir, [commit("o1", "d1", "delta", 250), commit("o2", "o1", "delta", 260)], {})
}

const cids = async (aStore: VersionLogStore, aDir: string): Promise<string[]> => {
  return (await aStore.listCommits(aDir)).map((aCommit) => aCommit.cid)
}

describe("GC (S8)", () => {
  test("orphans go first; a fitting policy keeps the whole reachable chain", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedAnchored(store, dir)
    expect((await store.stats(dir)).orphans).toBe(2)

    const stats = await store.gc(dir, { maxCommits: 10 })
    expect(stats.orphans).toBe(0)
    expect(await cids(store, dir)).toEqual(["s0", "d1", "s1", "d2", "s2", "d3"])
  })

  test("the OLDEST anchor that fits wins — history is kept maximal within the limit", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedAnchored(store, dir)

    // Fits from s1 (4 commits s1,d2,s2,d3) but not from s0 (6).
    await store.gc(dir, { maxCommits: 4 })
    const kept = await store.listCommits(dir)
    expect(kept.map((aCommit) => aCommit.cid)).toEqual(["s1", "d2", "s2", "d3"])

    // The cut-off anchor became a grafted root; everything else kept its parent (S8д analog).
    expect(kept[0]).toMatchObject({ cid: "s1", parent: null, seq: 3 })
    expect(kept[1]).toMatchObject({ cid: "d2", parent: "s1" })
  })

  test("payloads of kept commits are byte-identical after GC (S8д) and reconstruction agrees (S9)", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedAnchored(store, dir)

    const beforeChain = await store.readChain(dir, { from: "main", untilType: "snapshot" })
    await store.gc(dir, { maxCommits: 4 })
    const afterChain = await store.readChain(dir, { from: "main", untilType: "snapshot" })

    // The adoption read (main back to the nearest snapshot) is untouched by the GC cut.
    expect(afterChain.commits).toEqual(beforeChain.commits)

    store.forget(dir)
    expect(await store.readChain(dir, { from: "main", untilType: "snapshot" })).toEqual(afterChain)
  })

  test("nothing fits: the minimal chain from the newest anchor survives the limit (S8в)", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedAnchored(store, dir)

    await store.gc(dir, { maxCommits: 1 })
    expect(await cids(store, dir)).toEqual(["s2", "d3"])
    expect((await store.getRefs(dir)).main).toBe("d3")
  })

  test("head and tags are GC roots: their chains survive down to their own snapshot (S8г)", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedAnchored(store, dir)
    // Protect the orphan tip with a tag and park head mid-chain.
    await store.putRefs(dir, { head: "d2", tags: { pin: "o2" } })

    await store.gc(dir, { maxCommits: 2 })
    const kept = await store.listCommits(dir)
    // Minimal main [s2,d3] + head chain d2→s1 + tag chain o2→o1→d1→s0 (its nearest snapshot).
    expect(kept.map((aCommit) => aCommit.cid)).toEqual(["s0", "d1", "s1", "d2", "s2", "d3", "o1", "o2"])
    const refs = await store.getRefs(dir)
    expect(refs.head).toBe("d2")
    expect(refs.tags).toEqual({ pin: "o2" })
  })

  test("maxAgeMs cuts anchors older than the cutoff (with a deterministic nowMs)", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedAnchored(store, dir)

    // now=1000: s0(100)/s1(300) are older than now-600=400, s2(500) is not.
    await store.gc(dir, { maxAgeMs: 600, nowMs: 1000 })
    expect(await cids(store, dir)).toEqual(["s2", "d3"])
  })

  test("maxBytes picks the oldest anchor whose grafted encoding fits", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedAnchored(store, dir)

    const full = (await store.stats(dir)).bytes
    await store.gc(dir, { maxBytes: Math.floor(full * 0.6) })
    const kept = await cids(store, dir)
    expect(kept.length).toBeLessThan(6)
    expect(kept[kept.length - 1]).toBe("d3")
    expect((await store.stats(dir)).bytes).toBeLessThanOrEqual(Math.floor(full * 0.6))
  })

  test("a log without snapshots is never cut — orphan removal only", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await store.append(
      dir,
      [commit("r", null, "delta", 1), commit("a", "r", "delta", 2), commit("b", "a", "delta", 3)],
      { advanceMain: true },
    )
    await store.append(dir, [commit("o", "r", "delta", 4)], {})

    await store.gc(dir, { maxCommits: 1 })
    expect(await cids(store, dir)).toEqual(["r", "a", "b"])
  })

  test("gc is idempotent and consolidates segments into one", async () => {
    const store = createVersionLogStore({ segmentMaxBytes: 1 })
    const dir = await makeLogDir()
    await seedAnchored(store, dir)
    expect((await store.stats(dir)).segments).toBe(8)

    const first = await store.gc(dir, { maxCommits: 4 })
    expect(first.segments).toBe(1)
    const state = await store.listCommits(dir)

    const second = await store.gc(dir, { maxCommits: 4 })
    expect(await store.listCommits(dir)).toEqual(state)
    expect(second).toEqual(first)
  })

  test("append-triggered gc runs only when the policy is violated (VL-D6)", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedAnchored(store, dir)

    // Not violated: 8 commits ≤ 10 — the orphans stay untouched.
    await store.append(dir, [commit("d4", "d3", "delta", 700)], { advanceMain: true, gc: { maxCommits: 10 } })
    expect((await store.stats(dir)).orphans).toBe(2)

    // Violated: 9 commits > 4 — GC fires within the same append call.
    await store.append(dir, [commit("d5", "d4", "delta", 800)], { advanceMain: true, gc: { maxCommits: 4 } })
    expect(await cids(store, dir)).toEqual(["s2", "d3", "d4", "d5"])
    expect((await store.stats(dir)).orphans).toBe(0)
  })

  test("a stale pre-GC segment left by a crashed cleanup is cut on reload, appends continue", async () => {
    const store = createVersionLogStore({ segmentMaxBytes: 1 })
    const dir = await makeLogDir()
    await seedAnchored(store, dir)

    // Snapshot the pre-GC bytes of a middle segment, GC, then "resurrect" the old file as the
    // crash between rename and deletes would leave it.
    const preNames = (await readdir(dir)).filter((aName) => aName.endsWith(".jsonl")).sort()
    const resurrect = preNames[2]!
    const { readFile } = await import("node:fs/promises")
    const oldBytes = await readFile(join(dir, resurrect))

    await store.gc(dir, { maxCommits: 4 })
    const postGc = await store.listCommits(dir)
    await writeFile(join(dir, resurrect), oldBytes)

    store.forget(dir)
    expect(await store.listCommits(dir)).toEqual(postGc)
    const appended = await store.append(dir, [commit("d9", "d3", "delta", 900)], { advanceMain: true })
    expect(appended.appended).toBe(1)
    store.forget(dir)
    expect((await cids(store, dir)).at(-1)).toBe("d9")
  })
})
