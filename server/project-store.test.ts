import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import {
  PROJECTS_DIR_NAME,
  isProjectStoreError,
  normalizeSourcePath,
  projectDirName,
  projectSlug,
  resolveProjectDir,
} from "./project-store"

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
