import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readdir, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { AudioCacheManifest, pruneDirectoryToBudget } from "./audio-cache-manifest"

const roots: string[] = []
async function makeFixture(): Promise<{ root: string; renderDir: string; convertDir: string; manifestPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "cache-manifest-"))
  roots.push(root)
  const renderDir = join(root, "audio-render")
  const convertDir = join(root, "audio-conversion")
  await mkdir(renderDir, { recursive: true })
  await mkdir(convertDir, { recursive: true })
  return { root, renderDir, convertDir, manifestPath: join(root, "audio-cache-manifest.json") }
}
async function writeBytes(path: string, size: number): Promise<void> {
  await writeFile(path, Buffer.alloc(size, 1))
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }).catch(() => undefined)))
})

describe("AudioCacheManifest (GT6.1 / GT-D11)", () => {
  test("records provenance and summarizes by source with a running total", async () => {
    const { renderDir, convertDir, manifestPath } = await makeFixture()
    const a1 = join(renderDir, "song-aaa.wav")
    const a2 = join(renderDir, "song-bbb.wav")
    const b1 = join(convertDir, "other-ccc.flac")
    await writeBytes(a1, 100)
    await writeBytes(a2, 200)
    await writeBytes(b1, 50)

    const m = new AudioCacheManifest(manifestPath, [renderDir, convertDir])
    await m.record(a1, "/src/song.gnaural", "wav", "single-loop")
    await m.record(a2, "/src/song.gnaural", "wav", "render")
    await m.record(b1, "/src/other.mp3", "flac", "convert")

    const summary = await m.summary()
    expect(summary.totalBytes).toBe(350)
    expect(summary.orphanBytes).toBe(0)
    // sources sorted by size desc: song (300) then other (50)
    expect(summary.sources.map((s) => s.sourcePath)).toEqual(["/src/song.gnaural", "/src/other.mp3"])
    const song = summary.sources[0]!
    expect(song.totalBytes).toBe(300)
    expect(song.entries.length).toBe(2)
    expect(song.entries.map((e) => e.discriminator).sort()).toEqual(["render", "single-loop"])
  })

  test("reports files with no manifest entry as orphans; the manifest persists + reloads", async () => {
    const { renderDir, convertDir, manifestPath } = await makeFixture()
    const known = join(renderDir, "known-xxx.wav")
    const orphan = join(renderDir, "orphan-yyy.wav")
    await writeBytes(known, 10)
    await writeBytes(orphan, 40)

    const m = new AudioCacheManifest(manifestPath, [renderDir, convertDir])
    await m.record(known, "/src/known.gnaural", "wav", "render")

    const summary = await m.summary()
    expect(summary.orphanBytes).toBe(40)
    expect(summary.orphans.map((o) => o.cacheFile)).toContain(orphan)
    expect(existsSync(manifestPath)).toBe(true)

    // A fresh instance reloads the persisted manifest.
    const m2 = new AudioCacheManifest(manifestPath, [renderDir, convertDir])
    const s2 = await m2.summary()
    expect(s2.sources.find((s) => s.sourcePath === "/src/known.gnaural")).toBeDefined()
  })

  test("delete by entry / by source / all; and a path-traversal guard", async () => {
    const { root, renderDir, convertDir, manifestPath } = await makeFixture()
    const a1 = join(renderDir, "s-1.wav")
    const a2 = join(renderDir, "s-2.wav")
    const b1 = join(convertDir, "t-1.flac")
    for (const f of [a1, a2, b1]) await writeBytes(f, 10)

    const m = new AudioCacheManifest(manifestPath, [renderDir, convertDir])
    await m.record(a1, "/src/s.gnaural", "wav", "render")
    await m.record(a2, "/src/s.gnaural", "wav", "single-loop")
    await m.record(b1, "/src/t.mp3", "flac", "convert")

    expect(await m.deleteEntry(a1)).toBe(true)
    expect(existsSync(a1)).toBe(false)

    // path guard: a file outside the cache dirs is refused (and not touched)
    const outside = join(root, "outside.txt")
    await writeBytes(outside, 5)
    expect(await m.deleteEntry(outside)).toBe(false)
    expect(existsSync(outside)).toBe(true)

    expect(await m.deleteBySource("/src/s.gnaural")).toBe(1) // a2 remains
    expect(existsSync(a2)).toBe(false)

    const removed = await m.clearAll()
    expect(removed).toBe(1) // only b1 left
    expect(existsSync(b1)).toBe(false)
    expect((await m.summary()).totalBytes).toBe(0)
  })
})

describe("pruneDirectoryToBudget (wave-spectrum-cache WC3.1)", () => {
  const ageOrder = async (aDir: string, aNames: string[]): Promise<void> => {
    // Stamp increasing mtimes so aNames[0] is the oldest.
    for (let i = 0; i < aNames.length; i += 1) {
      const when = new Date(1_700_000_000_000 + i * 60_000)
      await utimes(join(aDir, aNames[i]!), when, when)
    }
  }

  test("evicts oldest files first until within budget; leaves newer ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prune-"))
    roots.push(dir)
    // 4 files x 100 bytes = 400; budget 250 -> must drop the 2 oldest (down to 200).
    for (const n of ["a", "b", "c", "d"]) await writeBytes(join(dir, `${n}.tileblob`), 100)
    await ageOrder(dir, ["a.tileblob", "b.tileblob", "c.tileblob", "d.tileblob"])

    const res = await pruneDirectoryToBudget(dir, 250)
    expect(res.removed).toBe(2)
    expect(res.freedBytes).toBe(200)
    const left = (await readdir(dir)).sort()
    expect(left).toEqual(["c.tileblob", "d.tileblob"]) // oldest two gone
  })

  test("no-op when already within budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prune-"))
    roots.push(dir)
    await writeBytes(join(dir, "only.tileblob"), 50)
    const res = await pruneDirectoryToBudget(dir, 1000)
    expect(res.removed).toBe(0)
    expect(existsSync(join(dir, "only.tileblob"))).toBe(true)
  })

  test("skips dotfiles (in-progress temps) and tolerates a missing directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prune-"))
    roots.push(dir)
    await writeBytes(join(dir, ".partial.tmp"), 100)
    await writeBytes(join(dir, "real.tileblob"), 100)
    // budget 0 forces eviction of everything eligible, but the dotfile is never touched.
    const res = await pruneDirectoryToBudget(dir, 0)
    expect(res.removed).toBe(1)
    expect(existsSync(join(dir, ".partial.tmp"))).toBe(true)
    expect(existsSync(join(dir, "real.tileblob"))).toBe(false)

    const missing = await pruneDirectoryToBudget(join(dir, "does-not-exist"), 0)
    expect(missing).toEqual({ removed: 0, freedBytes: 0 })
  })
})
