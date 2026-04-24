import type { AppSession } from "./app-session"
import type { LogArchiveStore } from "./log-db"
import {
  getRuntimeEventTimestampMs,
  toJson,
  type ArchivedLogEventRecord,
  type LogDeviceSummary,
  type LogSessionKind,
  type ReplayFinishedEvent,
  type ReplayProgressEvent,
  type ReplaySpeed,
  type ReplayStartedEvent,
  type ReplayStoppedEvent,
} from "./protocol"

const REPLAY_PAGE_SIZE = 500

export interface ReplayPublisher {
  publish(topic: string, data: string): unknown
}

interface ActiveReplayState {
  readonly sessionId: number
  readonly sessionName: string
  readonly kind: LogSessionKind
  readonly devices: readonly LogDeviceSummary[]
  readonly playbackId: number
  speed: ReplaySpeed
  cursorTimestampMs: number | null
  stopRequested: boolean
}

export interface ReplayStartResult {
  readonly ok: boolean
  readonly error?: string
}

export interface LogReplayManager {
  isActive(): boolean
  getSnapshot(): ReplayStartedEvent | null
  startReplay(server: ReplayPublisher, sessionId: number): Promise<ReplayStartResult>
  stopReplay(server: ReplayPublisher): Promise<boolean>
  setReplaySpeed(server: ReplayPublisher, speed: ReplaySpeed): boolean
}

interface CreateLogReplayManagerOptions {
  readonly archiveStore: LogArchiveStore
  readonly processManager: AppSession
  readonly restoreLiveProcess: (server: ReplayPublisher) => Promise<void>
}

const toReplayStartedEvent = (replayState: ActiveReplayState): ReplayStartedEvent => {
  return {
    type: "replay_started",
    sessionId: replayState.sessionId,
    sessionName: replayState.sessionName,
    kind: replayState.kind,
    devices: replayState.devices,
    speed: replayState.speed,
    ...(replayState.cursorTimestampMs !== null ? { cursorTimestampMs: replayState.cursorTimestampMs } : {}),
  }
}

const publishReplayEvent = (
  server: ReplayPublisher,
  event: ReplayStartedEvent | ReplayStoppedEvent | ReplayFinishedEvent
): void => {
  server.publish("ui", toJson(event))
}

const publishReplayProgress = (
  server: ReplayPublisher,
  replayState: ActiveReplayState,
): void => {
  const event: ReplayProgressEvent = {
    type: "replay_progress",
    sessionId: replayState.sessionId,
    speed: replayState.speed,
    ...(replayState.cursorTimestampMs !== null ? { cursorTimestampMs: replayState.cursorTimestampMs } : {}),
  }

  server.publish("ui", toJson(event))
}

const publishArchivedEvent = (server: ReplayPublisher, archivedEvent: ArchivedLogEventRecord): void => {
  server.publish("ui", toJson(archivedEvent.payload))
}

const getArchivedEventTimestampMs = (event: ArchivedLogEventRecord): number | null => {
  if (event.payload.type === "bodymonitor_output") {
    const runtimeTimestampMs = getRuntimeEventTimestampMs(event.payload.parsedJson)
    if (runtimeTimestampMs !== null) {
      return runtimeTimestampMs
    }
  }

  const archivedTimestampMs = Date.parse(event.createdAt)
  return Number.isFinite(archivedTimestampMs) ? archivedTimestampMs : null
}

export const createLogReplayManager = (
  options: CreateLogReplayManagerOptions
): LogReplayManager => {
  let nextPlaybackId = 1
  let activeReplay: ActiveReplayState | null = null

  const isCurrentReplay = (replayState: ActiveReplayState): boolean => {
    return activeReplay !== null
      && activeReplay.playbackId === replayState.playbackId
      && !activeReplay.stopRequested
  }

  const restartLiveProcess = async (server: ReplayPublisher): Promise<void> => {
    try {
      await options.restoreLiveProcess(server)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to restore BodyMonitor after replay"
      server.publish("ui", toJson({ type: "bodymonitor_error", message }))
    }
  }

  const waitWithCancellation = async (
    replayState: ActiveReplayState,
    sourceDelayMs: number,
  ): Promise<boolean> => {
    let remainingSourceDelayMs = Math.max(0, Math.trunc(sourceDelayMs))

    while (remainingSourceDelayMs > 0) {
      if (!isCurrentReplay(replayState)) {
        return false
      }

      const currentSpeed = replayState.speed
      const sleepSliceMs = Math.min(Math.max(remainingSourceDelayMs / currentSpeed, 1), 100)
      await Bun.sleep(sleepSliceMs)
      remainingSourceDelayMs = Math.max(0, remainingSourceDelayMs - sleepSliceMs * currentSpeed)
    }

    return isCurrentReplay(replayState)
  }

  const runPlayback = async (
    server: ReplayPublisher,
    replayState: ActiveReplayState,
  ): Promise<void> => {
    try {
      let cursor = 0
      let previousTimestampMs: number | null = null

      while (isCurrentReplay(replayState)) {
        const events = options.archiveStore.listSessionEvents(replayState.sessionId, cursor, REPLAY_PAGE_SIZE)
        if (events.length === 0) {
          break
        }

        for (const event of events) {
          if (!isCurrentReplay(replayState)) {
            return
          }

          const eventTimestampMs = getArchivedEventTimestampMs(event)
          if (previousTimestampMs !== null && eventTimestampMs !== null) {
            const sourceDelayMs = Math.max(0, eventTimestampMs - previousTimestampMs)
            if (!await waitWithCancellation(replayState, sourceDelayMs)) {
              return
            }
          }

          publishArchivedEvent(server, event)
          if (eventTimestampMs !== null) {
            replayState.cursorTimestampMs = eventTimestampMs
            previousTimestampMs = eventTimestampMs
          }
          publishReplayProgress(server, replayState)
          cursor = event.seqNo
        }

        if (events.length < REPLAY_PAGE_SIZE) {
          break
        }

        await Bun.sleep(0)
      }

      if (isCurrentReplay(replayState)) {
        const finishedEvent: ReplayFinishedEvent = {
          type: "replay_finished",
          sessionId: replayState.sessionId,
        }
        publishReplayEvent(server, finishedEvent)
      }
    } catch (error) {
      if (!isCurrentReplay(replayState)) {
        return
      }

      const message = error instanceof Error ? error.message : "Replay failed"
      server.publish("ui", toJson({ type: "bodymonitor_error", message }))
      activeReplay = null
      await restartLiveProcess(server)
    }
  }

  return {
    isActive(): boolean {
      return activeReplay !== null
    },

    getSnapshot(): ReplayStartedEvent | null {
      if (activeReplay === null) {
        return null
      }

      return toReplayStartedEvent(activeReplay)
    },

    async startReplay(server: ReplayPublisher, sessionId: number): Promise<ReplayStartResult> {
      const currentReplay = activeReplay

      if (currentReplay === null && options.archiveStore.hasActiveSession()) {
        return { ok: false, error: "Stop the active scan or monitoring session before replay" }
      }

      const session = options.archiveStore.getSession(sessionId)
      if (session === null) {
        return { ok: false, error: "Archived log not found" }
      }

      const firstPage = options.archiveStore.listSessionEvents(sessionId, 0, 1)
      if (firstPage.length === 0) {
        return { ok: false, error: "Archived log has no events to replay" }
      }

      if (currentReplay !== null && currentReplay.sessionId === sessionId) {
        publishReplayEvent(server, toReplayStartedEvent(currentReplay))
        return { ok: true }
      }

      if (currentReplay === null) {
        await options.processManager.stop()
      } else {
        currentReplay.stopRequested = true
        publishReplayEvent(server, {
          type: "replay_stopped",
          sessionId: currentReplay.sessionId,
        })
      }

      activeReplay = {
        sessionId,
        sessionName: session.effectiveName,
        kind: session.kind,
        devices: session.deviceSummary,
        playbackId: nextPlaybackId,
        speed: 1,
        cursorTimestampMs: null,
        stopRequested: false,
      }
      nextPlaybackId += 1

      publishReplayEvent(server, toReplayStartedEvent(activeReplay))

      void runPlayback(server, activeReplay)
      return { ok: true }
    },

    async stopReplay(server: ReplayPublisher): Promise<boolean> {
      if (activeReplay === null) {
        return false
      }

      const sessionId = activeReplay.sessionId
      activeReplay.stopRequested = true
      activeReplay = null

      publishReplayEvent(server, {
        type: "replay_stopped",
        sessionId,
      })

      await restartLiveProcess(server)
      return true
    },

    setReplaySpeed(server: ReplayPublisher, speed: ReplaySpeed): boolean {
      if (activeReplay === null) {
        return false
      }

      activeReplay.speed = speed
      publishReplayProgress(server, activeReplay)
      return true
    },
  }
}
