// VL1.1 (plan docs/undo-versioned-log): unit conformance for the spec invariants S1–S5, S7,
// S10, S12 + segment rotation and chain reads. The byte-sweep crash harness (S6) is VL1.2 and
// the fuzz/oracle suite (S1–S9, S11) is VL1.3 — this file covers the directly-constructible
// cases one by one, in the project-store.test.ts fixture idiom.
import { mkdtemp, readFile, readdir, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import {
  VERSION_LOG_REFS_FILE_NAME,
  createVersionLogStore,
  isVersionLogError,
  type VersionLogCommitInput,
  type VersionLogStore,
} from "./version-log-store"

const fixtureRoots: string[] = []
const makeLogDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "version-log-"))
  fixtureRoots.push(root)
  return join(root, "undo-log")
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(fixtureRoots.splice(0).map((aRoot) => rm(aRoot, { recursive: true, force: true }).catch(() => undefined)))
})

let atMsCounter = 1_000
const delta = (aCid: string, aParent: string | null, aPayload?: unknown): VersionLogCommitInput => {
  atMsCounter += 1
  return { cid: aCid, parent: aParent, type: "delta", atMs: atMsCounter, payload: aPayload ?? { v: aCid } }
}

const snapshot = (aCid: string, aParent: string | null): VersionLogCommitInput => {
  atMsCounter += 1
  return { cid: aCid, parent: aParent, type: "snapshot", atMs: atMsCounter, payload: { full: aCid } }
}

const expectLogError = async (aPromise: Promise<unknown>, aStatus: number): Promise<void> => {
  let caught: unknown = null
  try {
    await aPromise
  } catch (error) {
    caught = error
  }
  expect(isVersionLogError(caught)).toBe(true)
  expect(isVersionLogError(caught) ? caught.status : 0).toBe(aStatus)
}

/** Seed a fresh log with root -> a -> b (advanceMain). */
const seedThree = async (aStore: VersionLogStore, aDir: string): Promise<void> => {
  const result = await aStore.append(aDir, [delta("root", null), delta("a", "root"), delta("b", "a")], { advanceMain: true })
  expect(result.appended).toBe(3)
  expect(result.rejectedFrom).toBeNull()
}

describe("append + read back (S1, S4)", () => {
  test("commits round-trip with server-assigned increasing seq and survive a reopen", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedThree(store, dir)

    const chain = await store.readChain(dir, { from: "main" })
    expect(chain.commits.map((aCommit) => aCommit.cid)).toEqual(["b", "a", "root"])
    expect(chain.hasMore).toBe(false)

    const all = await store.listCommits(dir)
    expect(all.map((aCommit) => aCommit.seq)).toEqual([1, 2, 3])
    expect(all.map((aCommit) => aCommit.cid)).toEqual(["root", "a", "b"])

    store.forget(dir)
    const reloaded = await store.listCommits(dir)
    expect(reloaded).toEqual(all)
    expect((await store.getRefs(dir)).main).toBe("b")
  })

  test("seq keeps increasing across a reopen (S4)", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedThree(store, dir)

    store.forget(dir)
    const result = await store.append(dir, [delta("c", "b")], { advanceMain: true })
    expect(result.appended).toBe(1)
    const all = await store.listCommits(dir)
    expect(all[all.length - 1]).toMatchObject({ cid: "c", seq: 4 })
  })

  test("appending never mutates earlier commits (S1)", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedThree(store, dir)
    const before = structuredClone([...(await store.listCommits(dir))])

    await store.append(dir, [delta("c", "b")], { advanceMain: true })
    const after = await store.listCommits(dir)
    expect(after.slice(0, 3)).toEqual(before)
  })

  test("payload defaults to null and unicode payloads round-trip", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await store.append(dir, [{ cid: "r", parent: null, type: "meta", atMs: 1, payload: undefined }], {})
    await store.append(dir, [delta("u", "r", { text: "метка → 🎵 \"quoted\"" })], {})

    store.forget(dir)
    const all = await store.listCommits(dir)
    expect(all[0]?.payload).toBeNull()
    expect(all[1]?.payload).toEqual({ text: "метка → 🎵 \"quoted\"" })
  })
})

describe("idempotency (S2)", () => {
  test("re-appending the same batch is a no-op with identical final state", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    const batch = [delta("root", null), delta("a", "root"), delta("b", "a")]

    await store.append(dir, batch, { advanceMain: true })
    const firstState = { commits: await store.listCommits(dir), refs: await store.getRefs(dir) }

    const retry = await store.append(dir, batch, { advanceMain: true })
    expect(retry.appended).toBe(0)
    expect(retry.skipped).toBe(3)
    expect({ commits: await store.listCommits(dir), refs: await store.getRefs(dir) }).toEqual(firstState)
  })

  test("a mixed batch skips known commits and appends new ones", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedThree(store, dir)

    const result = await store.append(dir, [delta("b", "a"), delta("c", "b")], { advanceMain: true })
    expect(result.skipped).toBe(1)
    expect(result.appended).toBe(1)
    expect(result.refs.main).toBe("c")
  })
})

describe("chain integrity (S3)", () => {
  test("an unknown parent cuts the batch to the accepted prefix", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()

    const result = await store.append(dir, [delta("root", null), delta("x", "nope"), delta("y", "x")], { advanceMain: true })
    expect(result.appended).toBe(1)
    expect(result.rejectedFrom).toBe("x")
    expect(result.rejectedReason).toBe("unknown-parent")
    expect((await store.listCommits(dir)).map((aCommit) => aCommit.cid)).toEqual(["root"])
    expect(result.refs.main).toBe("root")
  })

  test("a second root is rejected once the log is non-empty", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedThree(store, dir)

    const result = await store.append(dir, [delta("root2", null)], {})
    expect(result.appended).toBe(0)
    expect(result.rejectedFrom).toBe("root2")
  })

  test("parents may be satisfied by earlier commits of the same batch", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    const result = await store.append(dir, [delta("r", null), delta("m", "r"), delta("n", "m")], {})
    expect(result.appended).toBe(3)
    expect(result.rejectedFrom).toBeNull()
  })
})

describe("refs (S5)", () => {
  test("head moves independently of main; tags set/delete and survive a reopen", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedThree(store, dir)

    await store.putRefs(dir, { head: "a", tags: { До_эксперимента: "a", wip: "b" } })
    await store.putRefs(dir, { tags: { wip: null } })

    store.forget(dir)
    const refs = await store.getRefs(dir)
    expect(refs).toEqual({ main: "b", head: "a", tags: { До_эксперимента: "a" } })
  })

  test("unknown cids are rejected with 404 and nothing is applied", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedThree(store, dir)

    await expectLogError(store.putRefs(dir, { main: "ghost" }), 404)
    await expectLogError(store.putRefs(dir, { tags: { pin: "ghost" } }), 404)
    expect((await store.getRefs(dir)).main).toBe("b")
  })

  test("an invalid tag name rejects the whole patch atomically (400)", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedThree(store, dir)

    await expectLogError(store.putRefs(dir, { head: "a", tags: { "bad name": "b" } }), 400)
    await expectLogError(store.putRefs(dir, { tags: { "": "b" } }), 400)
    await expectLogError(store.putRefs(dir, { tags: { [`${"x".repeat(65)}`]: "b" } }), 400)
    expect((await store.getRefs(dir)).head).toBeNull()
  })

  test("main can be cleared with null; advanceMain touches neither head nor tags", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedThree(store, dir)
    await store.putRefs(dir, { head: "a", tags: { pin: "root" } })

    await store.append(dir, [delta("c", "b")], { advanceMain: true })
    let refs = await store.getRefs(dir)
    expect(refs.main).toBe("c")
    expect(refs.head).toBe("a")
    expect(refs.tags).toEqual({ pin: "root" })

    refs = await store.putRefs(dir, { main: null })
    expect(refs.main).toBeNull()
  })

  test("advanceMain lands on the last batch cid even when the batch was fully skipped (retry)", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    const batch = [delta("root", null), delta("a", "root")]
    await store.append(dir, batch, {})
    expect((await store.getRefs(dir)).main).toBeNull()

    const retry = await store.append(dir, batch, { advanceMain: true })
    expect(retry.appended).toBe(0)
    expect(retry.refs.main).toBe("a")
  })
})

describe("tolerant read (S7)", () => {
  test("a corrupt middle line cuts the log, preserves the remainder, and repoints refs", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await store.append(dir, [delta("r", null), delta("a", "r"), delta("b", "a"), delta("c", "b")], { advanceMain: true })

    const segments = (await readdir(dir)).filter((aName) => aName.endsWith(".jsonl"))
    expect(segments).toEqual(["seg-00000001.jsonl"])
    const filePath = join(dir, segments[0]!)
    const lines = (await readFile(filePath, "utf8")).split("\n")
    lines[2] = "{ this is not json"
    await writeFile(filePath, lines.join("\n"), "utf8")

    store.forget(dir)
    expect((await store.listCommits(dir)).map((aCommit) => aCommit.cid)).toEqual(["r", "a"])
    const refs = await store.getRefs(dir)
    expect(refs.main).toBe("a")

    const brokenFiles = (await readdir(dir)).filter((aName) => aName.includes(".broken-"))
    expect(brokenFiles.length).toBe(1)

    const appended = await store.append(dir, [delta("d", "a")], { advanceMain: true })
    expect(appended.appended).toBe(1)
    store.forget(dir)
    expect((await store.listCommits(dir)).map((aCommit) => aCommit.cid)).toEqual(["r", "a", "d"])
  })

  test("corruption in an early segment moves every later segment aside", async () => {
    const store = createVersionLogStore({ segmentMaxBytes: 1 })
    const dir = await makeLogDir()
    await store.append(dir, [delta("r", null), delta("a", "r"), delta("b", "a")], { advanceMain: true })
    expect((await readdir(dir)).filter((aName) => aName.endsWith(".jsonl")).length).toBe(3)

    await writeFile(join(dir, "seg-00000002.jsonl"), "garbage\n", "utf8")
    store.forget(dir)

    expect((await store.listCommits(dir)).map((aCommit) => aCommit.cid)).toEqual(["r"])
    const names = await readdir(dir)
    expect(names.filter((aName) => aName.endsWith(".jsonl"))).toEqual(["seg-00000001.jsonl", "seg-00000002.jsonl"])
    expect(names.filter((aName) => aName.startsWith("seg-00000003.jsonl.broken-")).length).toBe(1)
    expect((await store.getRefs(dir)).main).toBe("r")
  })

  test("a corrupt first line yields an empty, usable log", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await store.append(dir, [delta("r", null)], { advanceMain: true })
    await writeFile(join(dir, "seg-00000001.jsonl"), "nonsense\n", "utf8")

    store.forget(dir)
    expect(await store.listCommits(dir)).toEqual([])
    expect((await store.getRefs(dir)).main).toBeNull()

    const result = await store.append(dir, [delta("fresh", null)], { advanceMain: true })
    expect(result.appended).toBe(1)
  })
})

describe("torn tail (S6 smoke — full byte sweep lives in VL1.2)", () => {
  test("a half-written last line is dropped and the next append continues cleanly", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedThree(store, dir)

    const filePath = join(dir, "seg-00000001.jsonl")
    const size = (await readFile(filePath)).length
    await truncate(filePath, size - 5)

    store.forget(dir)
    expect((await store.listCommits(dir)).map((aCommit) => aCommit.cid)).toEqual(["root", "a"])

    await store.append(dir, [delta("b2", "a")], { advanceMain: true })
    store.forget(dir)
    expect((await store.listCommits(dir)).map((aCommit) => aCommit.cid)).toEqual(["root", "a", "b2"])
  })

  test("a complete last line missing only its newline keeps the commit and repairs on append", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedThree(store, dir)

    const filePath = join(dir, "seg-00000001.jsonl")
    const size = (await readFile(filePath)).length
    await truncate(filePath, size - 1)

    store.forget(dir)
    expect((await store.listCommits(dir)).map((aCommit) => aCommit.cid)).toEqual(["root", "a", "b"])

    await store.append(dir, [delta("c", "b")], {})
    store.forget(dir)
    expect((await store.listCommits(dir)).map((aCommit) => aCommit.cid)).toEqual(["root", "a", "b", "c"])
  })
})

describe("segment rotation (VL-D3)", () => {
  test("tiny segments rotate per commit with monotonic names and read back correctly", async () => {
    const store = createVersionLogStore({ segmentMaxBytes: 1 })
    const dir = await makeLogDir()
    await store.append(dir, [delta("r", null), delta("a", "r")], { advanceMain: true })
    await store.append(dir, [delta("b", "a")], { advanceMain: true })

    const stats = await store.stats(dir)
    expect(stats.segments).toBe(3)
    expect(stats.commits).toBe(3)

    store.forget(dir)
    const chain = await store.readChain(dir, { from: "main" })
    expect(chain.commits.map((aCommit) => aCommit.cid)).toEqual(["b", "a", "r"])

    await store.append(dir, [delta("c", "b")], {})
    const names = (await readdir(dir)).filter((aName) => aName.endsWith(".jsonl")).sort()
    expect(names[names.length - 1]).toBe("seg-00000004.jsonl")
  })
})

describe("clear (S12)", () => {
  test("clear empties the log and a new root becomes appendable", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedThree(store, dir)
    await store.putRefs(dir, { tags: { pin: "a" } })

    await store.clear(dir)
    expect(await store.listCommits(dir)).toEqual([])
    expect(await store.getRefs(dir)).toEqual({ main: null, head: null, tags: {} })
    expect((await store.stats(dir)).bytes).toBe(0)

    const result = await store.append(dir, [delta("fresh", null)], { advanceMain: true })
    expect(result.appended).toBe(1)
  })

  test("clear on a never-created log is a no-op", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await store.clear(dir)
    expect(await store.listCommits(dir)).toEqual([])
  })
})

describe("per-commit sanity limit (S10)", () => {
  test("an oversized commit rejects the whole call atomically with 413", async () => {
    const store = createVersionLogStore({ commitMaxBytes: 200 })
    const dir = await makeLogDir()

    const batch = [delta("r", null), delta("big", "r", { blob: "x".repeat(500) })]
    await expectLogError(store.append(dir, batch, { advanceMain: true }), 413)
    expect(await store.listCommits(dir)).toEqual([])
    expect((await store.getRefs(dir)).main).toBeNull()
  })
})

describe("readChain options", () => {
  test("limit pages the chain and untilType stops at the first snapshot inclusively", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await store.append(
      dir,
      [snapshot("s0", null), delta("a", "s0"), snapshot("s1", "a"), delta("b", "s1"), delta("c", "b")],
      { advanceMain: true },
    )

    const page = await store.readChain(dir, { from: "main", limit: 2 })
    expect(page.commits.map((aCommit) => aCommit.cid)).toEqual(["c", "b"])
    expect(page.hasMore).toBe(true)

    const rest = await store.readChain(dir, { from: page.commits[page.commits.length - 1]!.parent!, limit: 10 })
    expect(rest.commits.map((aCommit) => aCommit.cid)).toEqual(["s1", "a", "s0"])
    expect(rest.hasMore).toBe(false)

    const adoption = await store.readChain(dir, { from: "main", untilType: "snapshot" })
    expect(adoption.commits.map((aCommit) => aCommit.cid)).toEqual(["c", "b", "s1"])
    expect(adoption.hasMore).toBe(true)
  })

  test("a null ref reads as an empty chain; an unknown cid is 404", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedThree(store, dir)

    const byHead = await store.readChain(dir, { from: "head" })
    expect(byHead.commits).toEqual([])
    expect(byHead.hasMore).toBe(false)

    await expectLogError(store.readChain(dir, { from: "ghost" }), 404)
  })
})

describe("input validation (400)", () => {
  test("malformed commit shapes are rejected before touching the log", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()

    const bad: unknown[] = [
      { cid: "", parent: null, type: "delta", atMs: 1, payload: null },
      { cid: "x".repeat(201), parent: null, type: "delta", atMs: 1, payload: null },
      { cid: "ok", parent: "", type: "delta", atMs: 1, payload: null },
      { cid: "ok", parent: null, type: "branch", atMs: 1, payload: null },
      { cid: "ok", parent: null, type: "delta", atMs: Number.NaN, payload: null },
    ]
    for (const input of bad) {
      await expectLogError(store.append(dir, [input as VersionLogCommitInput], {}), 400)
    }
    expect(await store.listCommits(dir)).toEqual([])
  })
})

describe("serialization smoke (S11 — the full check is the VL1.3 fuzz)", () => {
  test("two concurrent dependent appends serialize in call order", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()

    const [first, second] = await Promise.all([
      store.append(dir, [delta("r", null)], { advanceMain: true }),
      store.append(dir, [delta("a", "r")], { advanceMain: true }),
    ])
    expect(first.appended).toBe(1)
    expect(second.appended).toBe(1)
    expect((await store.listCommits(dir)).map((aCommit) => aCommit.seq)).toEqual([1, 2])
  })
})

describe("foreign refs.json content", () => {
  test("an unreadable refs.json falls back to the newest commit", async () => {
    const store = createVersionLogStore()
    const dir = await makeLogDir()
    await seedThree(store, dir)
    await writeFile(join(dir, VERSION_LOG_REFS_FILE_NAME), "not json at all", "utf8")

    store.forget(dir)
    const refs = await store.getRefs(dir)
    expect(refs.main).toBe("b")
    expect(refs.head).toBe("b")
    expect(refs.tags).toEqual({})
  })
})
