// FB1.5 (file-browser plan): LocalFsProvider coverage — temp-tree listing, parent boundaries, the
// hidden-file filter, stat on files/dirs/absent paths, and OS-aware roots (a Windows drive letter
// when on win32).

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { createLocalFsProvider } from "./fs-browser-local"

const roots: string[] = []

const makeTree = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "fs-browser-"))
  roots.push(root)
  await mkdir(join(root, "sub"), { recursive: true })
  await writeFile(join(root, "song.wav"), Buffer.alloc(120, 1))
  await writeFile(join(root, "notes.TXT"), Buffer.alloc(30, 1))
  await writeFile(join(root, ".hidden"), Buffer.alloc(10, 1))
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }).catch(() => undefined)))
})

describe("LocalFsProvider (FB1.2)", () => {
  test("listDir returns dirs and files with kind/size/ext; hides dotfiles by default", async () => {
    const root = await makeTree()
    const provider = createLocalFsProvider()

    const result = await provider.listDir(root)
    const byName = new Map(result.entries.map((e) => [e.name, e]))

    expect(byName.has(".hidden")).toBe(false)
    expect(byName.get("sub")?.isDir).toBe(true)
    expect(byName.get("sub")?.kind).toBe("dir")
    expect(byName.get("sub")?.size).toBe(0)

    const wav = byName.get("song.wav")
    expect(wav?.isDir).toBe(false)
    expect(wav?.kind).toBe("file")
    expect(wav?.size).toBe(120)
    expect(wav?.ext).toBe("wav")

    // Extension is lowercased regardless of the on-disk casing.
    expect(byName.get("notes.TXT")?.ext).toBe("txt")
  })

  test("listDir includes dotfiles when showHidden is set", async () => {
    const root = await makeTree()
    const provider = createLocalFsProvider()

    const result = await provider.listDir(root, { showHidden: true })
    expect(result.entries.some((e) => e.name === ".hidden")).toBe(true)
  })

  test("listDir reports the parent dir, and null at a root boundary", async () => {
    const root = await makeTree()
    const provider = createLocalFsProvider()

    const sub = await provider.listDir(join(root, "sub"))
    expect(sub.parent).toBe(root)

    const roots = await provider.listRoots()
    expect(roots.length).toBeGreaterThan(0)
    const anchor = roots[0]!
    const atRoot = await provider.listDir(anchor.path)
    // A drive root / '/' has no parent to climb to.
    if (anchor.kind === "drive" || anchor.kind === "root") {
      expect(atRoot.parent).toBeNull()
    }
  })

  test("stat classifies a file, a dir, and an absent path", async () => {
    const root = await makeTree()
    const provider = createLocalFsProvider()

    const fileStat = await provider.stat(join(root, "song.wav"))
    expect(fileStat.exists).toBe(true)
    expect(fileStat.isFile).toBe(true)
    expect(fileStat.size).toBe(120)

    const dirStat = await provider.stat(join(root, "sub"))
    expect(dirStat.isDir).toBe(true)

    const missing = await provider.stat(join(root, "nope.xyz"))
    expect(missing.exists).toBe(false)
  })

  test("listRoots is OS-aware", async () => {
    const provider = createLocalFsProvider()
    const rootList = await provider.listRoots()
    expect(rootList.length).toBeGreaterThan(0)

    if (platform() === "win32") {
      const drive = rootList.find((r) => r.kind === "drive")
      expect(drive).toBeDefined()
      expect(drive!.path).toMatch(/^[A-Z]:\\$/)
    } else {
      expect(rootList.some((r) => r.kind === "root" && r.path === "/")).toBe(true)
    }
  })
})
