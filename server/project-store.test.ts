import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import {
  PROJECT_FILE_NAME,
  PROJECTS_DIR_NAME,
  SerialQueues,
  createProjectFileData,
  isProjectStoreError,
  normalizeSourcePath,
  projectDirName,
  projectSlug,
  readProjectFile,
  resolveProjectDir,
  writeProjectFile,
} from "./project-store"

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
