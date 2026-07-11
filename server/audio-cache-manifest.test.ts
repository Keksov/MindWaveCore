import { existsSync } from "node:fs"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { AudioCacheManifest } from "./audio-cache-manifest"

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
