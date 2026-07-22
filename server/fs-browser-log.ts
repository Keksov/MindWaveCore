// FB-diag (2026-07-22): observability for the file-browse subsystem. Both the loopback fs server
// (fs-browser-server.ts) and the local provider (fs-browser-local.ts) were completely silent, so the
// intermittent "opening a folder sticks on the hourglass forever" bug left NOTHING in any log — the
// hang is a single slow/blocking stat() with no timeout, and nothing ever threw. This module gives a
// durable, human-readable trail in var/fs-browser.log (gitignored, like the other runtime logs) plus
// a stdout mirror. It is PURE instrumentation: no behavior change, never throws into a request.
import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"

// This module lives in server/, so import.meta.dir IS the server dir — var/ sits beside it (the same
// place createLogArchiveStore uses: join(serverDir, "var")).
const LOG_DIR = join(import.meta.dir, "var")
export const FS_LOG_PATH = join(LOG_DIR, "fs-browser.log")

// A request/stat that has not finished within this budget is "slow" — the watchdogs start naming it.
// Tuned well below the multi-second stalls we care about, well above a healthy local listing (~ms).
export const FS_SLOW_MS = 5000

// Serialize appends so concurrent requests can't interleave a half-written line. Seeded with the
// one-time mkdir; every failure is swallowed — diagnostics must never break (or slow) a request.
let writeChain: Promise<unknown> = mkdir(LOG_DIR, { recursive: true }).catch(() => undefined)

const stamp = (): string => new Date().toISOString()

// One log line, mirrored to stdout (the dev console) and appended to the file. fs listings are
// user-paced, not high-frequency, so mirroring everything is cheap and keeps the console useful too.
export const fsLog = (aMessage: string): void => {
  const line = `${stamp()} ${aMessage}`
  try {
    console.log(`[fs-browser] ${aMessage}`)
  } catch {
    // console can throw on a torn-down stream during shutdown; ignore.
  }
  writeChain = writeChain
    .catch(() => undefined)
    .then(() => appendFile(FS_LOG_PATH, `${line}\n`))
    .catch(() => undefined)
}
