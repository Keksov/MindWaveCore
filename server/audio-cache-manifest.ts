// GT6.1 (owner req. 13, GT-D11): a manifest for the audio output cache.
//
// The server caches gnaural->WAV renders (tmp/audio-render, incl. the single-loop variant) and
// audio conversions (tmp/audio-conversion). The cache key is a one-way sha1(path+size+mtime+kind+
// discriminator) — there is no reverse cache->source mapping. So on every cache write we record a
// manifest entry {cacheFile, sourcePath, kind, discriminator, bytes, createdAt}; the UI (GT6.2)
// then shows the total size, a per-source breakdown, and can delete by entry / by source / all.
// Files present in the cache dirs but absent from the manifest (older builds) are reported as
// "orphans" (unknown source).

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"

export interface CacheManifestEntry {
  readonly cacheFile: string
  readonly sourcePath: string
  readonly kind: string
  readonly discriminator: string
  readonly bytes: number
  readonly createdAt: string
}

export interface CacheSummaryEntry {
  readonly cacheFile: string
  readonly kind: string
  readonly discriminator: string
  readonly bytes: number
  readonly createdAt: string | null
}

export interface CacheSummarySource {
  readonly sourcePath: string
  readonly sourceName: string
  readonly totalBytes: number
  readonly entries: CacheSummaryEntry[]
}

export interface CacheSummary {
  readonly totalBytes: number
  readonly sources: CacheSummarySource[]
  readonly orphanBytes: number
  readonly orphans: CacheSummaryEntry[]
}

const isInside = (aBase: string, aTarget: string): boolean => {
  const base = resolve(aBase)
  const target = resolve(aTarget)
  return target === base || target.startsWith(base + sep)
}

export class AudioCacheManifest {
  private readonly entries = new Map<string, CacheManifestEntry>() // key = resolved cacheFile
  private readonly ready: Promise<void>
  private writeChain: Promise<void> = Promise.resolve()

  public constructor(
    private readonly manifestPath: string,
    private readonly cacheDirs: readonly string[],
  ) {
    this.ready = this.load()
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.manifestPath, "utf8")) as unknown
      if (Array.isArray(parsed)) {
        for (const raw of parsed) {
          if (raw !== null && typeof raw === "object" && typeof (raw as { cacheFile?: unknown }).cacheFile === "string") {
            const e = raw as CacheManifestEntry
            const key = resolve(e.cacheFile)
            this.entries.set(key, { ...e, cacheFile: key })
          }
        }
      }
    } catch {
      // no manifest yet / unreadable -> start empty
    }
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(
      async () => {
        try {
          await mkdir(dirname(this.manifestPath), { recursive: true })
          await writeFile(this.manifestPath, JSON.stringify([...this.entries.values()], null, 2))
        } catch {
          // storage failure -> keep the in-memory manifest; retried on the next write
        }
      },
      () => undefined,
    )
    await this.writeChain
  }

  /** Record (or refresh) a cache file's provenance. Call after the file is finalized; never throws. */
  public async record(cacheFile: string, sourcePath: string, kind: string, discriminator: string): Promise<void> {
    await this.ready
    const key = resolve(cacheFile)
    let bytes = 0
    try {
      bytes = (await stat(key)).size
    } catch {
      // file vanished between finalize and record — still record with 0 bytes; summary reconciles
    }
    this.entries.set(key, { cacheFile: key, sourcePath, kind, discriminator, bytes, createdAt: new Date().toISOString() })
    await this.persist()
  }

  /** Scan the cache dirs, join with the manifest, group by source; unknown files become orphans. */
  public async summary(): Promise<CacheSummary> {
    await this.ready
    const bySource = new Map<string, CacheSummarySource & { entries: CacheSummaryEntry[] }>()
    const orphans: CacheSummaryEntry[] = []
    let totalBytes = 0
    let orphanBytes = 0
    const seen = new Set<string>()

    for (const dir of this.cacheDirs) {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (name.startsWith(".")) continue // temp / in-progress files
        const full = resolve(join(dir, name))
        let fileStat
        try {
          fileStat = await stat(full)
        } catch {
          continue
        }
        if (!fileStat.isFile()) continue
        seen.add(full)
        totalBytes += fileStat.size
        const entry = this.entries.get(full)
        if (entry !== undefined) {
          const src = bySource.get(entry.sourcePath) ?? {
            sourcePath: entry.sourcePath,
            sourceName: basename(entry.sourcePath),
            totalBytes: 0,
            entries: [],
          }
          src.entries.push({ cacheFile: full, kind: entry.kind, discriminator: entry.discriminator, bytes: fileStat.size, createdAt: entry.createdAt })
          src.totalBytes += fileStat.size
          bySource.set(entry.sourcePath, src)
        } else {
          orphans.push({ cacheFile: full, kind: name.split(".").pop() ?? "", discriminator: "", bytes: fileStat.size, createdAt: null })
          orphanBytes += fileStat.size
        }
      }
    }

    // prune manifest entries whose file no longer exists on disk
    for (const key of [...this.entries.keys()]) if (!seen.has(key)) this.entries.delete(key)

    const sources = [...bySource.values()].sort((a, b) => b.totalBytes - a.totalBytes)
    return { totalBytes, sources, orphanBytes, orphans }
  }

  /** Resolve + confirm a cache file is inside one of the managed cache dirs (path-traversal guard). */
  private guard(cacheFile: string): string | null {
    const key = resolve(cacheFile)
    return this.cacheDirs.some((dir) => isInside(dir, key)) ? key : null
  }

  /** Delete one cache file (must be inside a cache dir). Returns true when the path was valid. */
  public async deleteEntry(cacheFile: string): Promise<boolean> {
    await this.ready
    const key = this.guard(cacheFile)
    if (key === null) return false
    await rm(key, { force: true }).catch(() => undefined)
    this.entries.delete(key)
    await this.persist()
    return true
  }

  /** Delete every cache file whose manifest source == sourcePath. Returns the count removed. */
  public async deleteBySource(sourcePath: string): Promise<number> {
    await this.ready
    const targets = [...this.entries.values()].filter((e) => e.sourcePath === sourcePath)
    let count = 0
    for (const e of targets) {
      const key = this.guard(e.cacheFile)
      if (key === null) continue
      await rm(key, { force: true }).catch(() => undefined)
      this.entries.delete(key)
      count += 1
    }
    await this.persist()
    return count
  }

  /** Delete all cache files in the managed dirs (except temp files) + clear the manifest. */
  public async clearAll(): Promise<number> {
    await this.ready
    let count = 0
    for (const dir of this.cacheDirs) {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (name.startsWith(".")) continue
        await rm(join(dir, name), { force: true }).catch(() => undefined)
        count += 1
      }
    }
    this.entries.clear()
    await this.persist()
    return count
  }
}
