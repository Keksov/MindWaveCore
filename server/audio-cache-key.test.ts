// wave-spectrum-cache WC1.1 (WC-D2): the content-addressed key must reuse a render across a touch /
// no-op re-save (mtime changes, content does not) and re-render when content changes. The default
// (no-fingerprint) branch must keep the historical size+mtime behavior so existing WAV/convert cache
// entries stay valid.

import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { getAudioOutputCachePath, gnauralContentFingerprint } from "./audio-cache-key"

const roots: string[] = []
async function fixtureDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cache-key-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }).catch(() => undefined)))
})

describe("getAudioOutputCachePath (wave-spectrum-cache WC1.1 / WC-D2)", () => {
  test("content-addressed: a touch (mtime bump, same content) keeps the same cache path", async () => {
    const dir = await fixtureDir()
    const src = join(dir, "ForestMeditation.gnaural")
    const content = "<gnaural><loops>5</loops></gnaural>"
    await writeFile(src, content)

    const fp1 = gnauralContentFingerprint(content)
    const before = await getAudioOutputCachePath(src, "wav", dir, "single-loop", fp1)

    // simulate a touch: bump mtime a second into the future, content untouched
    const future = new Date(Date.now() + 1000)
    await utimes(src, future, future)

    const fp2 = gnauralContentFingerprint(await Bun.file(src).text())
    const after = await getAudioOutputCachePath(src, "wav", dir, "single-loop", fp2)

    expect(fp2).toBe(fp1)
    expect(after).toBe(before) // cache HIT despite the mtime change
  })

  test("content-addressed: changing content changes the cache path (re-render)", async () => {
    const dir = await fixtureDir()
    const src = join(dir, "ForestMeditation.gnaural")
    await writeFile(src, "<gnaural><loops>5</loops></gnaural>")
    const original = await getAudioOutputCachePath(src, "wav", dir, "single-loop", gnauralContentFingerprint(await Bun.file(src).text()))

    await writeFile(src, "<gnaural><loops>5</loops><voice/></gnaural>")
    const edited = await getAudioOutputCachePath(src, "wav", dir, "single-loop", gnauralContentFingerprint(await Bun.file(src).text()))

    expect(edited).not.toBe(original) // cache MISS -> re-render
  })

  test("content-addressed: the discriminator (project voice-mute) still partitions the key", async () => {
    const dir = await fixtureDir()
    const src = join(dir, "s.gnaural")
    const content = "<gnaural/>"
    await writeFile(src, content)
    const fp = gnauralContentFingerprint(content)
    const plain = await getAudioOutputCachePath(src, "wav", dir, "single-loop", fp)
    const muted = await getAudioOutputCachePath(src, "wav", dir, "single-loop|muted:3=1", fp)
    expect(muted).not.toBe(plain)
  })

  test("default branch (no fingerprint) keys on size+mtime — historical behavior preserved", async () => {
    const dir = await fixtureDir()
    const src = join(dir, "song.wav")
    await writeFile(src, Buffer.alloc(64, 1))
    const before = await getAudioOutputCachePath(src, "flac", dir, "")

    const future = new Date(Date.now() + 2000)
    await utimes(src, future, future)
    const after = await getAudioOutputCachePath(src, "flac", dir, "")

    expect(after).not.toBe(before) // mtime change alone busts the pass-through cache, as before
  })

  test("content and size+mtime modes produce different keys for the same source", async () => {
    const dir = await fixtureDir()
    const src = join(dir, "s.gnaural")
    const content = "<gnaural/>"
    await writeFile(src, content)
    const contentKey = await getAudioOutputCachePath(src, "wav", dir, "", gnauralContentFingerprint(content))
    const mtimeKey = await getAudioOutputCachePath(src, "wav", dir, "")
    expect(contentKey).not.toBe(mtimeKey)
  })
})
