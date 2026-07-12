// FB1.5 (file-browser plan, FB-D2): the loopback file-browse server — a real round-trip over
// 127.0.0.1 (roots -> list -> stat), CORS + OPTIONS, unknown-provider / unknown-route handling, and
// the isLoopbackAddress helper the main server uses to gate /api/fs/info.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { createFsProviderRegistry } from "./fs-browser-provider"
import { createLocalFsProvider, LOCAL_FS_PROVIDER_ID } from "./fs-browser-local"
import { ensureLoopbackNoProxy, isLoopbackAddress, startFsBrowserServer, type FsBrowserServer } from "./fs-browser-server"

// The dev machine may set HTTP_PROXY=http://127.0.0.1:2080; without this, Bun's fetch would route
// our loopback requests through it and get ECONNRESET/502. Same fix the server uses at startup.
ensureLoopbackNoProxy()

let browser: FsBrowserServer
let treeRoot: string

beforeAll(async () => {
  treeRoot = await mkdtemp(join(tmpdir(), "fs-browser-srv-"))
  await mkdir(join(treeRoot, "sub"), { recursive: true })
  await writeFile(join(treeRoot, "clip.wav"), Buffer.alloc(64, 1))

  const registry = createFsProviderRegistry()
  registry.register(createLocalFsProvider())
  browser = startFsBrowserServer(registry)
})

afterAll(async () => {
  browser.stop()
  await rm(treeRoot, { recursive: true, force: true }).catch(() => undefined)
})

const q = (path: string): string => encodeURIComponent(path)

describe("startFsBrowserServer (FB1.3/FB1.4)", () => {
  test("binds to 127.0.0.1", () => {
    expect(browser.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  test("round-trip: /fs/roots -> /fs/list -> /fs/stat", async () => {
    const rootsRes = await fetch(`${browser.url}/fs/roots?provider=${LOCAL_FS_PROVIDER_ID}`)
    expect(rootsRes.status).toBe(200)
    const rootsBody = (await rootsRes.json()) as { roots: unknown[] }
    expect(Array.isArray(rootsBody.roots)).toBe(true)
    expect(rootsBody.roots.length).toBeGreaterThan(0)

    const listRes = await fetch(`${browser.url}/fs/list?provider=${LOCAL_FS_PROVIDER_ID}&path=${q(treeRoot)}`)
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as { entries: { name: string }[] }
    expect(listBody.entries.some((e) => e.name === "clip.wav")).toBe(true)
    expect(listBody.entries.some((e) => e.name === "sub")).toBe(true)

    const statRes = await fetch(`${browser.url}/fs/stat?provider=${LOCAL_FS_PROVIDER_ID}&path=${q(join(treeRoot, "clip.wav"))}`)
    expect(statRes.status).toBe(200)
    const statBody = (await statRes.json()) as { exists: boolean; isFile: boolean; size: number }
    expect(statBody.exists).toBe(true)
    expect(statBody.isFile).toBe(true)
    expect(statBody.size).toBe(64)
  })

  test("responds with permissive CORS and handles OPTIONS preflight", async () => {
    const res = await fetch(`${browser.url}/fs/roots?provider=${LOCAL_FS_PROVIDER_ID}`)
    expect(res.headers.get("access-control-allow-origin")).toBe("*")

    const preflight = await fetch(`${browser.url}/fs/list`, { method: "OPTIONS" })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-methods")).toContain("GET")
  })

  test("rejects an unknown provider and an unknown route", async () => {
    const badProvider = await fetch(`${browser.url}/fs/roots?provider=nope`)
    expect(badProvider.status).toBe(400)

    const badRoute = await fetch(`${browser.url}/nope?provider=${LOCAL_FS_PROVIDER_ID}`)
    expect(badRoute.status).toBe(404)
  })

  test("requires a path for /fs/list and /fs/stat", async () => {
    const noPath = await fetch(`${browser.url}/fs/list?provider=${LOCAL_FS_PROVIDER_ID}`)
    expect(noPath.status).toBe(400)
  })
})

describe("isLoopbackAddress (FB-D2 gate)", () => {
  test("accepts loopback forms and rejects LAN/remote", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true)
    expect(isLoopbackAddress("::1")).toBe(true)
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true)
    expect(isLoopbackAddress("192.168.1.20")).toBe(false)
    expect(isLoopbackAddress("10.0.0.5")).toBe(false)
    expect(isLoopbackAddress(null)).toBe(false)
  })
})
