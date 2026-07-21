import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import {
  PROJECT_FILE_NAME,
  PROJECTS_DIR_NAME,
  SerialQueues,
  UNDO_FILE_NAME,
  UNDO_LOG_DIR_NAME,
  copyProjectsTree,
  createProjectFileData,
  createProjectStore,
  defaultUserDataRoot,
  isProjectStoreError,
  isSafeProjectId,
  normalizeSourcePath,
  projectDirName,
  projectSlug,
  readProjectFile,
  resolveProjectDir,
  writeProjectFile,
} from "./project-store"
import { createVersionLogStore } from "./version-log-store"

const expectStoreError = async (aPromise: Promise<unknown>, aStatus: number): Promise<void> => {
  let caught: unknown = null
  try {
    await aPromise
  } catch (error) {
    caught = error
  }
  expect(isProjectStoreError(caught)).toBe(true)
  expect(isProjectStoreError(caught) ? caught.status : 0).toBe(aStatus)
}

const fixtureRoots: string[] = []
const makeFixtureDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "project-store-"))
  fixtureRoots.push(root)
  return root
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(fixtureRoots.splice(0).map((aRoot) => rm(aRoot, { recursive: true, force: true }).catch(() => undefined)))
})

const HASH8_SUFFIX = /-[0-9a-f]{8}$/

describe("project identity + folder layout (PR1.1 / PR-D2, PR-D3)", () => {
  test("the same file in a different path case lands in the same project dir", () => {
    const path = join(tmpdir(), "kksc-id", "MySchedule.gnaural")
    expect(projectDirName(path.toUpperCase())).toBe(projectDirName(path.toLowerCase()))
    expect(projectDirName(path)).toMatch(HASH8_SUFFIX)
  })

  test("different directories with the same basename get different projects", () => {
    const first = join(tmpdir(), "kksc-a", "song.gnaural")
    const second = join(tmpdir(), "kksc-b", "song.gnaural")
    expect(projectDirName(first)).not.toBe(projectDirName(second))
    expect(projectDirName(first).startsWith("song-")).toBe(true)
  })

  test("slug keeps cyrillic, replaces forbidden/whitespace chars, strips the extension", () => {
    expect(projectSlug(join(tmpdir(), "Мой Файл (v2).gnaural"))).toBe("мой_файл_(v2)")
    expect(projectSlug(join(tmpdir(), 'a<B>c"D.gnaural'))).toBe("a_b_c_d")
  })

  test("slug caps the length at 40 chars", () => {
    const slug = projectSlug(join(tmpdir(), `${"x".repeat(60)}.gnaural`))
    expect(slug).toBe("x".repeat(40))
  })

  test("degenerate names fall back to a usable slug", () => {
    expect(projectSlug(join(tmpdir(), ".gnaural"))).toBe("gnaural")
    expect(projectSlug(join(tmpdir(), "___.gnaural"))).toBe("project")
  })

  test("resolveProjectDir puts the project under <root>/projects/<slug>-<hash8>", () => {
    const root = join(tmpdir(), "kksc-root")
    const source = join(tmpdir(), "presets", "Alpha.gnaural")
    const dir = resolveProjectDir(root, source)
    expect(dir).toBe(join(root, PROJECTS_DIR_NAME, projectDirName(source)))
    expect(dir).toMatch(HASH8_SUFFIX)
  })

  test("an empty path is rejected with a 400 ProjectStoreError", () => {
    let caught: unknown = null
    try {
      normalizeSourcePath("   ")
    } catch (error) {
      caught = error
    }
    expect(isProjectStoreError(caught)).toBe(true)
    expect(isProjectStoreError(caught) ? caught.status : 0).toBe(400)
  })
})

describe("project.scp.json storage (PR1.2 / PR-D4, PR-D7)", () => {
  const sampleSource = (aDir: string) => ({
    path: join(aDir, "Sample.gnaural"),
    sizeBytes: 123,
    modifiedAtMs: 456789,
  })

  test("write/read round-trip preserves the data and leaves no temp files", async () => {
    const dir = await makeFixtureDir()
    const data = createProjectFileData(sampleSource(dir))
    await writeProjectFile(dir, { ...data, sections: { view: { zoom: 2 } } })

    const loaded = await readProjectFile(dir)
    expect(loaded).not.toBeNull()
    expect(loaded?.source).toEqual(data.source)
    expect(loaded?.sections).toEqual({ view: { zoom: 2 } })

    const names = await readdir(dir)
    expect(names.filter((aName) => aName.includes(".tmp-"))).toEqual([])
  })

  test("unknown sections and unknown top-level fields survive a rewrite", async () => {
    const dir = await makeFixtureDir()
    const data = createProjectFileData(sampleSource(dir))
    const foreign = {
      ...data,
      futureTopLevel: { anything: true },
      sections: { fromFutureSubsystem: [1, 2, 3] },
    }
    await writeFile(join(dir, PROJECT_FILE_NAME), JSON.stringify(foreign, null, 2))

    const loaded = await readProjectFile(dir)
    expect(loaded).not.toBeNull()
    await writeProjectFile(dir, {
      ...loaded!,
      sections: { ...loaded!.sections, view: { zoom: 1 } },
    })

    const raw = await readFile(join(dir, PROJECT_FILE_NAME), "utf8")
    const reread = JSON.parse(raw) as Record<string, unknown>
    expect(reread.futureTopLevel).toEqual({ anything: true })
    expect((reread.sections as Record<string, unknown>).fromFutureSubsystem).toEqual([1, 2, 3])
    expect((reread.sections as Record<string, unknown>).view).toEqual({ zoom: 1 })
  })

  test("a missing file reads as null without side effects", async () => {
    const dir = await makeFixtureDir()
    expect(await readProjectFile(dir)).toBeNull()
    expect(await readdir(dir)).toEqual([])
  })

  test("corrupt JSON is moved aside to .broken-<ts>, original bytes preserved", async () => {
    const dir = await makeFixtureDir()
    await writeFile(join(dir, PROJECT_FILE_NAME), "{ not json")

    expect(await readProjectFile(dir)).toBeNull()
    expect(existsSync(join(dir, PROJECT_FILE_NAME))).toBe(false)

    const names = await readdir(dir)
    const broken = names.filter((aName) => aName.startsWith(`${PROJECT_FILE_NAME}.broken-`))
    expect(broken.length).toBe(1)
    expect(await readFile(join(dir, broken[0]!), "utf8")).toBe("{ not json")
  })

  test("a foreign schemaVersion is treated as broken, not silently rewritten", async () => {
    const dir = await makeFixtureDir()
    const data = createProjectFileData(sampleSource(dir))
    await writeFile(join(dir, PROJECT_FILE_NAME), JSON.stringify({ ...data, schemaVersion: 99 }))

    expect(await readProjectFile(dir)).toBeNull()
    const names = await readdir(dir)
    expect(names.some((aName) => aName.startsWith(`${PROJECT_FILE_NAME}.broken-`))).toBe(true)
  })

  test("SerialQueues: same key runs sequentially, different keys interleave, rejection does not poison the queue", async () => {
    const queues = new SerialQueues()
    const order: string[] = []
    let releaseFirst = () => {}
    const firstGate = new Promise<void>((aResolve) => {
      releaseFirst = aResolve
    })

    const first = queues.run("a", async () => {
      await firstGate
      order.push("a1")
    })
    const second = queues.run("a", async () => {
      order.push("a2")
    })
    const other = queues.run("b", async () => {
      order.push("b1")
    })

    await other
    expect(order).toEqual(["b1"])

    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(["b1", "a1", "a2"])

    await expect(queues.run("a", async () => {
      throw new Error("boom")
    })).rejects.toThrow("boom")
    await queues.run("a", async () => {
      order.push("a3")
    })
    expect(order).toEqual(["b1", "a1", "a2", "a3"])
  })
})

describe("ProjectStore core API (PR1.3 / PR-D5, PR-D8)", () => {
  const makeStoreFixture = async (): Promise<{ root: string; sourceDir: string; store: ReturnType<typeof createProjectStore> }> => {
    const root = await makeFixtureDir()
    const sourceDir = await makeFixtureDir()
    const store = createProjectStore({ resolveUserDataRoot: () => root })
    return { root, sourceDir, store }
  }

  const makeSourceFile = async (aDir: string, aName: string, aContent = "<gnaural/>"): Promise<string> => {
    const path = join(aDir, aName)
    await writeFile(path, aContent)
    return path
  }

  test("openProject provisions the folder + scp.json; reopening (any path case) finds the same project", async () => {
    const { root, sourceDir, store } = await makeStoreFixture()
    const source = await makeSourceFile(sourceDir, "Alpha.gnaural")

    const first = await store.openProject(source)
    expect(first.sourceStatus).toBe("ok")
    expect(existsSync(join(root, PROJECTS_DIR_NAME, first.id, PROJECT_FILE_NAME))).toBe(true)

    const second = await store.openProject(source.toUpperCase())
    expect(second.id).toBe(first.id)
    expect(second.source.path).toBe(first.source.path)

    const dirs = await readdir(join(root, PROJECTS_DIR_NAME))
    expect(dirs).toEqual([first.id])
  })

  test("openProject refreshes the source fingerprint after the file changes", async () => {
    const { sourceDir, store } = await makeStoreFixture()
    const source = await makeSourceFile(sourceDir, "grow.gnaural", "12345")

    const first = await store.openProject(source)
    expect(first.source.sizeBytes).toBe(5)

    await writeFile(source, "1234567890")
    const second = await store.openProject(source)
    expect(second.source.sizeBytes).toBe(10)
  })

  test("openProject on a missing source file fails with 404", async () => {
    const { sourceDir, store } = await makeStoreFixture()
    await expectStoreError(store.openProject(join(sourceDir, "nope.gnaural")), 404)
  })

  test("sections: put/get round-trip, null deletes, unknown project 404, bad name 400", async () => {
    const { sourceDir, store } = await makeStoreFixture()
    const source = await makeSourceFile(sourceDir, "sec.gnaural")
    const info = await store.openProject(source)

    await store.putSection(info.id, "gtrackLanes", { order: [2, 1] })
    expect(await store.getSection(info.id, "gtrackLanes")).toEqual({ order: [2, 1] })
    expect(await store.getSection(info.id, "absent")).toBeNull()

    const afterDelete = await store.putSection(info.id, "gtrackLanes", null)
    expect(afterDelete.sections).toEqual([])

    await expectStoreError(store.putSection("ghost-00000000", "view", {}), 404)
    await expectStoreError(store.getSection(info.id, "bad name!"), 400)
  })

  test("undoJournalBytes counts only the undo-log folder (UR-D3): a stray undo.json is invisible", async () => {
    const { root, sourceDir, store } = await makeStoreFixture()
    const source = await makeSourceFile(sourceDir, "footprint.gnaural")
    const opened = await store.openProject(source)
    expect(opened.undoJournalBytes).toBeNull()

    // A stray legacy undo.json (nothing produces these anymore) is not counted.
    await writeFile(
      join(root, PROJECTS_DIR_NAME, opened.id, UNDO_FILE_NAME),
      `${JSON.stringify({ schemaVersion: 1, updatedAt: "x", journal: { entries: ["legacy"] } })}\n`,
    )
    expect((await store.getProject(opened.id))?.undoJournalBytes).toBeNull()

    const logDir = join(root, PROJECTS_DIR_NAME, opened.id, UNDO_LOG_DIR_NAME)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(logDir, { recursive: true })
    await writeFile(join(logDir, "seg-00000001.jsonl"), "x".repeat(100))
    await writeFile(join(logDir, "refs.json"), "y".repeat(20))
    expect((await store.getProject(opened.id))?.undoJournalBytes).toBe(120)
  })

  test("deleteProject removes only a real project folder; evil ids are rejected", async () => {
    const { root, sourceDir, store } = await makeStoreFixture()
    const source = await makeSourceFile(sourceDir, "del.gnaural")
    const info = await store.openProject(source)

    expect(isSafeProjectId("../escape-00000000")).toBe(false)
    await expectStoreError(store.deleteProject("../escape-00000000"), 400)
    await expectStoreError(store.deleteProject("ghost-00000000"), 404)

    await store.deleteProject(info.id)
    expect(existsSync(join(root, PROJECTS_DIR_NAME, info.id))).toBe(false)
  })

  test("relink keeps the id and folder; reopening by the new path finds the project via the scan fallback", async () => {
    const { sourceDir, store } = await makeStoreFixture()
    const oldSource = await makeSourceFile(sourceDir, "old-name.gnaural")
    const newSource = await makeSourceFile(sourceDir, "new-name.gnaural")

    const info = await store.openProject(oldSource)
    await store.putSection(info.id, "view", { zoom: 3 })

    const relinked = await store.relinkProject(info.id, newSource)
    expect(relinked.id).toBe(info.id)
    expect(relinked.source.path).toBe(normalizeSourcePath(newSource))

    const reopened = await store.openProject(newSource)
    expect(reopened.id).toBe(info.id)
    expect(await store.getSection(reopened.id, "view")).toEqual({ zoom: 3 })
  })

  test("getProject reports a deleted source as missing; listProjects sorts by updatedAt and skips broken dirs without touching them", async () => {
    const { root, sourceDir, store } = await makeStoreFixture()
    const first = await makeSourceFile(sourceDir, "first.gnaural")
    const second = await makeSourceFile(sourceDir, "second.gnaural")

    const firstInfo = await store.openProject(first)
    await new Promise((aResolve) => setTimeout(aResolve, 5))
    const secondInfo = await store.openProject(second)

    const { rm: rmFile } = await import("node:fs/promises")
    await rmFile(first, { force: true })
    const refreshed = await store.getProject(firstInfo.id)
    expect(refreshed?.sourceStatus).toBe("missing")

    const brokenDir = join(root, PROJECTS_DIR_NAME, "broken-deadbeef")
    const { mkdir: mkdirP } = await import("node:fs/promises")
    await mkdirP(brokenDir, { recursive: true })
    await writeFile(join(brokenDir, PROJECT_FILE_NAME), "{ not json")

    const listed = await store.listProjects()
    expect(listed.map((aInfo) => aInfo.id)).toEqual([secondInfo.id, firstInfo.id])
    expect(await readFile(join(brokenDir, PROJECT_FILE_NAME), "utf8")).toBe("{ not json")
  })
})

describe("export/import bundle (PR5.1+PR5.2 / PR-D10)", () => {
  test("export -> import on another root restores sections and the undo LOG byte-for-byte (S15)", async () => {
    const rootA = await makeFixtureDir()
    const rootB = await makeFixtureDir()
    const sourceDir = await makeFixtureDir()
    const source = join(sourceDir, "bundle.gnaural")
    await writeFile(source, "<gnaural/>")

    const versionLogA = createVersionLogStore()
    const storeA = createProjectStore({ resolveUserDataRoot: () => rootA, versionLog: versionLogA })
    const info = await storeA.openProject(source)
    await storeA.putSection(info.id, "view", { zoom: 4 })

    // Seed a log with a graft root, an orphan branch and refs — the shapes GC leaves behind.
    const logDirA = join(rootA, PROJECTS_DIR_NAME, info.id, UNDO_LOG_DIR_NAME)
    await versionLogA.append(
      logDirA,
      [
        { cid: "r", parent: null, type: "snapshot", atMs: 1, payload: { sig: "s" } },
        { cid: "a", parent: "r", type: "delta", atMs: 2, payload: { v: 1 } },
        { cid: "b", parent: "a", type: "delta", atMs: 3, payload: { v: 2 } },
      ],
      { advanceMain: true },
    )
    await versionLogA.append(logDirA, [{ cid: "orphan", parent: "r", type: "delta", atMs: 4, payload: null }], {})
    await versionLogA.putRefs(logDirA, { head: "a", tags: { pin: "b" } })
    const sourceCommits = await versionLogA.listCommits(logDirA)
    const sourceRefs = await versionLogA.getRefs(logDirA)

    const bundle = await storeA.exportProject(info.id)
    expect(bundle.kind).toBe("SoundCoreProjectExport")
    expect(bundle.undoLog?.commits).toEqual(sourceCommits)
    expect(bundle.undoLog?.refs).toEqual(sourceRefs)
    expect(bundle.undo).toBeUndefined()

    const versionLogB = createVersionLogStore()
    const storeB = createProjectStore({ resolveUserDataRoot: () => rootB, versionLog: versionLogB })
    const imported = await storeB.importProject(JSON.parse(JSON.stringify(bundle)), false)
    expect(imported.id).toBe(info.id)
    expect(await storeB.getSection(imported.id, "view")).toEqual({ zoom: 4 })

    const logDirB = join(rootB, PROJECTS_DIR_NAME, imported.id, UNDO_LOG_DIR_NAME)
    expect(await versionLogB.listCommits(logDirB)).toEqual(sourceCommits)
    expect(await versionLogB.getRefs(logDirB)).toEqual(sourceRefs)
  })

  test("a pre-VL bundle's legacy `undo` journal is ignored on import (UR-D2): no undo.json, empty log", async () => {
    const root = await makeFixtureDir()
    const sourceDir = await makeFixtureDir()
    const source = join(sourceDir, "old-bundle.gnaural")
    await writeFile(source, "<gnaural/>")

    const versionLog = createVersionLogStore()
    const store = createProjectStore({ resolveUserDataRoot: () => root, versionLog })
    const info = await store.openProject(source)
    const bundle = await store.exportProject(info.id)
    const legacyBundle = { ...JSON.parse(JSON.stringify(bundle)), undo: { version: 3, steps: [] } }

    // Overwrite-import over a dir still holding a stale undo.json: swept, never read back.
    await writeFile(
      join(root, PROJECTS_DIR_NAME, info.id, UNDO_FILE_NAME),
      `${JSON.stringify({ schemaVersion: 1, updatedAt: "x", journal: { version: 3, steps: [] } })}\n`,
    )
    const imported = await store.importProject(legacyBundle, true)
    expect(existsSync(join(root, PROJECTS_DIR_NAME, imported.id, UNDO_FILE_NAME))).toBe(false)
    expect(await versionLog.listCommits(join(root, PROJECTS_DIR_NAME, imported.id, UNDO_LOG_DIR_NAME))).toEqual([])
  })

  test("import conflicts with 409 unless overwrite; junk bundles are rejected with 400", async () => {
    const root = await makeFixtureDir()
    const sourceDir = await makeFixtureDir()
    const source = join(sourceDir, "clash.gnaural")
    await writeFile(source, "<gnaural/>")

    const store = createProjectStore({ resolveUserDataRoot: () => root })
    const info = await store.openProject(source)
    await store.putSection(info.id, "view", { zoom: 1 })
    const bundle = await store.exportProject(info.id)

    await store.putSection(info.id, "view", { zoom: 9 })
    await expectStoreError(store.importProject(bundle, false), 409)
    expect(await store.getSection(info.id, "view")).toEqual({ zoom: 9 })

    const overwritten = await store.importProject(bundle, true)
    expect(overwritten.id).toBe(info.id)
    expect(await store.getSection(info.id, "view")).toEqual({ zoom: 1 })

    await expectStoreError(store.importProject({ nope: true }, false), 400)
  })
})

describe("copyProjectsTree (PR3.2 / PR-D6)", () => {
  test("copies project folders recursively, skips existing destinations, leaves the source intact", async () => {
    const fromRoot = await makeFixtureDir()
    const toRoot = await makeFixtureDir()
    const sourceDir = await makeFixtureDir()
    const store = createProjectStore({ resolveUserDataRoot: () => fromRoot })

    await writeFile(join(sourceDir, "one.gnaural"), "<gnaural/>")
    await writeFile(join(sourceDir, "two.gnaural"), "<gnaural/>")
    const first = await store.openProject(join(sourceDir, "one.gnaural"))
    await writeFile(
      join(fromRoot, PROJECTS_DIR_NAME, first.id, UNDO_FILE_NAME),
      `${JSON.stringify({ schemaVersion: 1, updatedAt: "x", journal: { entries: [1] } })}\n`,
    )
    const second = await store.openProject(join(sourceDir, "two.gnaural"))

    const summary = await copyProjectsTree(fromRoot, toRoot)
    expect(summary).toEqual({ copied: 2, skipped: 0 })
    expect(existsSync(join(toRoot, PROJECTS_DIR_NAME, first.id, PROJECT_FILE_NAME))).toBe(true)
    expect(existsSync(join(toRoot, PROJECTS_DIR_NAME, first.id, UNDO_FILE_NAME))).toBe(true)
    expect(existsSync(join(fromRoot, PROJECTS_DIR_NAME, second.id, PROJECT_FILE_NAME))).toBe(true)

    const again = await copyProjectsTree(fromRoot, toRoot)
    expect(again).toEqual({ copied: 0, skipped: 2 })
  })

  test("same root or missing source tree is a no-op", async () => {
    const root = await makeFixtureDir()
    expect(await copyProjectsTree(root, root)).toEqual({ copied: 0, skipped: 0 })
    const empty = await makeFixtureDir()
    expect(await copyProjectsTree(empty, root)).toEqual({ copied: 0, skipped: 0 })
  })
})

describe("defaultUserDataRoot (PR1.4 / PR-D6)", () => {
  test("resolves to %LOCALAPPDATA%\\KKSoundCore when LOCALAPPDATA is set", () => {
    const original = process.env.LOCALAPPDATA
    process.env.LOCALAPPDATA = join(tmpdir(), "local-app-data")
    try {
      expect(defaultUserDataRoot()).toBe(join(tmpdir(), "local-app-data", "KKSoundCore"))
    } finally {
      if (original === undefined) {
        delete process.env.LOCALAPPDATA
      } else {
        process.env.LOCALAPPDATA = original
      }
    }
  })
})
