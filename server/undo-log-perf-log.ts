// undo-log performance diagnostics (owner 2026-07-22): large schedules (e.g. ForestMeditation)
// feel noticeably slower on point edits than small ones (wakeup). AppCore's console is not
// reliably reachable when run hosted (the same reason fs-browser-log.ts exists), so this mirrors
// every timing to var/undo-log-perf.log as well as stdout — a concrete repro's log file shows
// exactly where server-side time goes. Pure instrumentation: no behavior change, never throws
// into a request.
import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"

// This module lives in server/, so import.meta.dir IS the server dir — var/ sits beside it, same
// as fs-browser-log.ts and createLogArchiveStore.
const LOG_DIR = join(import.meta.dir, "var")
export const UNDO_LOG_PERF_LOG_PATH = join(LOG_DIR, "undo-log-perf.log")

// THE master switch for the server-side apparatus — flip to true to profile again. Gates every
// perfLog call here AND armEventLoopLagProbe(). Its client-side counterpart is PERF_LOG_ENABLED in
// GnauralCore/ui/composables/perf-log.ts; a useful session usually wants BOTH. See AGENTS.md,
// «Perf diagnostics».
//
// OFF since 2026-07-23: the investigation it was written for is closed. Note that var/undo-log-perf.log
// is append-only and never rotated — it reached ~3 MB during one day of profiling, so switching this
// back on for a long session means keeping an eye on that file.
export const UNDO_LOG_PERF_LOG_ENABLED = false

// Serialize appends so concurrent requests can't interleave a half-written line.
let writeChain: Promise<unknown> = mkdir(LOG_DIR, { recursive: true }).catch(() => undefined)

const stamp = (): string => new Date().toISOString()

function writeLine(aLine: string): void {
  try {
    console.log(aLine)
  } catch {
    // console can throw on a torn-down stream during shutdown; ignore.
  }
  writeChain = writeChain
    .catch(() => undefined)
    .then(() => appendFile(UNDO_LOG_PERF_LOG_PATH, `${stamp()} ${aLine}\n`))
    .catch(() => undefined)
}

export function perfNow(): number {
  return performance.now()
}

/** Logs `[undo-log-perf] label: N.Nms key=value ...`. aStartMs = the perfNow() taken at the stage's start. */
export function perfLog(aLabel: string, aStartMs: number, aExtra?: Readonly<Record<string, number | string>>): void {
  if (!UNDO_LOG_PERF_LOG_ENABLED) return
  const ms = perfNow() - aStartMs
  const ctx = aExtra === undefined ? "" : ` ${Object.entries(aExtra).map(([k, v]) => `${k}=${v}`).join(" ")}`
  writeLine(`[undo-log-perf] ${aLabel}: ${ms.toFixed(1)}ms${ctx}`)
}

// 2026-07-22: a repro showed a request's own handler timer at ~10ms while the CLIENT measured a
// 300-700ms round trip for that same request — time lost before our handler code even got to run.
// Bun is single-threaded, so anything else in this process doing synchronous work (audio/spectrogram
// rendering, GC, a busy loop elsewhere) stalls every request regardless of which route it hits, and
// no per-request timer can see that. This measures the event loop directly: schedule a tick every
// LAG_CHECK_MS and log whenever the ACTUAL gap overshoots by more than the threshold — the overshoot
// is exactly how long the loop was blocked by something else. Self-arming: importing this module is
// enough; call armEventLoopLagProbe() once (server.ts does, at boot) to avoid arming it per-import.
const LAG_CHECK_MS = 250
const LAG_WARN_THRESHOLD_MS = 75

let lagProbeArmed = false
export function armEventLoopLagProbe(): void {
  if (lagProbeArmed || !UNDO_LOG_PERF_LOG_ENABLED) return
  lagProbeArmed = true
  let last = perfNow()
  const tick = (): void => {
    const now = perfNow()
    const drift = now - last - LAG_CHECK_MS
    if (drift > LAG_WARN_THRESHOLD_MS) {
      writeLine(`[undo-log-perf] event-loop lag: ${drift.toFixed(1)}ms (something else blocked the process)`)
    }
    last = now
    schedule()
  }
  const schedule = (): void => {
    const timer = setTimeout(tick, LAG_CHECK_MS)
    if (typeof timer === "object" && "unref" in timer) timer.unref()
  }
  schedule()
}
