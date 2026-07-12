// FB1.3/FB1.4 (file-browser plan, FB-D2): the file-browse capability lives on its OWN Bun.serve
// bound to 127.0.0.1, so it is unreachable over the LAN — this is the security boundary the owner
// chose (a separate loopback bind, not a per-request remote-address check). Transport is plain HTTP
// REST (GET /fs/roots, /fs/list, /fs/stat), matching the existing audio HTTP endpoints. CORS is
// permissive because only same-machine browsers can ever reach this port.

import type { FsProviderRegistry } from "./fs-browser-provider"

export interface FsBrowserServer {
  readonly port: number
  readonly url: string
  stop(): void
}

// Bun's fetch honors HTTP_PROXY/NO_PROXY. On machines with a local proxy tool (e.g.
// HTTP_PROXY=http://127.0.0.1:2080) same-machine loopback requests would be routed through the
// proxy and fail (ECONNRESET/502) — breaking the loopback file-browse server (FB-D2) and its tests.
// Ensure the loopback hosts are always in NO_PROXY so loopback is reachable, while leaving the proxy
// intact for genuine external hosts (bun install, etc.). Bun does NOT override env vars already set
// in the environment from a .env file, so this must mutate process.env in-process, early at startup.
export const ensureLoopbackNoProxy = (): void => {
  const loopbackHosts = ["localhost", "127.0.0.1", "::1"]
  for (const key of ["NO_PROXY", "no_proxy"] as const) {
    const existing = (process.env[key] ?? "")
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token !== "")
    const merged = new Set(existing)
    for (const host of loopbackHosts) {
      merged.add(host)
    }
    process.env[key] = [...merged].join(",")
  }
}

// Loopback detection for /api/fs/info on the main (LAN-facing) server. Covers IPv4, IPv6, and the
// IPv4-mapped-IPv6 form Bun may report.
export const isLoopbackAddress = (aAddress: string | null | undefined): boolean => {
  if (aAddress === null || aAddress === undefined || aAddress === "") {
    return false
  }
  return (
    aAddress === "127.0.0.1" ||
    aAddress.startsWith("127.") ||
    aAddress === "::1" ||
    aAddress === "::ffff:127.0.0.1" ||
    aAddress.startsWith("::ffff:127.")
  )
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
}

const jsonResponse = (aData: unknown, aStatus = 200): Response => {
  return new Response(JSON.stringify(aData), {
    status: aStatus,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS_HEADERS,
    },
  })
}

const errorResponse = (aStatus: number, aMessage: string): Response => {
  return jsonResponse({ error: aMessage }, aStatus)
}

const requirePath = (aUrl: URL): string | null => {
  const path = aUrl.searchParams.get("path")
  if (path === null || path.trim() === "") {
    return null
  }
  return path
}

export const startFsBrowserServer = (aRegistry: FsProviderRegistry): FsBrowserServer => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(aRequest) {
      if (aRequest.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS })
      }

      if (aRequest.method !== "GET") {
        return errorResponse(405, "Method not allowed")
      }

      const url = new URL(aRequest.url)
      const segments = url.pathname.split("/").filter(Boolean)
      if (segments[0] !== "fs") {
        return errorResponse(404, "Not found")
      }

      const providerId = url.searchParams.get("provider") ?? ""
      const provider = aRegistry.get(providerId)
      if (provider === undefined) {
        return errorResponse(400, `Unknown provider: ${providerId || "(none)"}`)
      }

      try {
        if (segments.length === 2 && segments[1] === "roots") {
          return jsonResponse({ provider: provider.id, roots: await provider.listRoots() })
        }

        if (segments.length === 2 && segments[1] === "list") {
          const path = requirePath(url)
          if (path === null) {
            return errorResponse(400, "path query parameter is required")
          }
          const showHidden = url.searchParams.get("hidden") === "1"
          return jsonResponse(await provider.listDir(path, { showHidden }))
        }

        if (segments.length === 2 && segments[1] === "stat") {
          const path = requirePath(url)
          if (path === null) {
            return errorResponse(400, "path query parameter is required")
          }
          return jsonResponse(await provider.stat(path))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "File-browse request failed"
        return errorResponse(500, message)
      }

      return errorResponse(404, "Not found")
    },
  })

  const port = server.port
  if (port === undefined) {
    throw new Error("File-browse server failed to bind to a port")
  }

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stop() {
      server.stop(true)
    },
  }
}
