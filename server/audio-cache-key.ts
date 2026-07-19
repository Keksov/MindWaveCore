// wave-spectrum-cache WC1.1 (WC-D2): the audio-output cache key, extracted from server.ts so it can
// be unit-tested and reused. server.ts boots Bun.serve at import, so its internals are not importable
// from a test; this module is side-effect-free.
//
// Two keying modes:
//  - size+mtime (default): pass-through renders/conversions of WAV/FLAC sources. Large sources are not
//    re-hashed on every request, and existing cache entries stay valid.
//  - content-addressed (aSourceFingerprint set): .gnaural spectrogram renders. A no-op re-save / touch
//    bumps mtime but not content, so the render is still reused. Owner-chosen (WC-D2).

import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { basename, extname, join } from "node:path"

// NUL separator between key fields — matches the historical server.ts key layout byte-for-byte, so
// the default (size+mtime) branch keeps existing tmp/audio-render + tmp/audio-conversion entries
// valid. Written as fromCharCode(0) to keep this source free of literal NUL bytes and escape ambiguity.
const KEY_SEP = String.fromCharCode(0)

/** sha1 of a .gnaural file's textual content — the content-addressed source fingerprint (WC-D2). */
export const gnauralContentFingerprint = (aContent: string): string =>
  createHash("sha1").update(aContent).digest("hex")

export const getAudioOutputCachePath = async (
  aSourceFilePath: string,
  aTargetFileKind: string,
  aCacheDir: string,
  aDiscriminator = "",
  // When set, the cache is content-addressed on this fingerprint instead of size+mtime (WC-D2).
  aSourceFingerprint?: string,
): Promise<string> => {
  const sourceName = basename(aSourceFilePath, extname(aSourceFilePath))
  const hash = createHash("sha1").update(aSourceFilePath).update(KEY_SEP)
  if (aSourceFingerprint !== undefined) {
    hash.update("content").update(KEY_SEP).update(aSourceFingerprint)
  } else {
    const sourceStat = await stat(aSourceFilePath)
    hash.update(String(sourceStat.size)).update(KEY_SEP).update(String(sourceStat.mtimeMs))
  }
  const cacheKey = hash
    .update(KEY_SEP)
    .update(aTargetFileKind)
    .update(KEY_SEP)
    .update(aDiscriminator)
    .digest("hex")

  return join(aCacheDir, `${sourceName}-${cacheKey}.${aTargetFileKind}`)
}
