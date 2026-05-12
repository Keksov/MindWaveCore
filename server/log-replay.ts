import type { AppSession } from "./app-session"
import type { LogArchiveStore } from "./log-db"
import {
  getRuntimeEventTimestampMs,
  toJson,
  type ArchivedLogEventRecord,
  type GnauralScheduleData,
  type LogDeviceSummary,
  type LogSessionKind,
  type ReplayFinishedEvent,
  type ReplayPausedEvent,
  type ReplayProgressEvent,
  type ReplaySpeed,
  type ReplayStartedEvent,
  type ReplayStoppedEvent,
} from "./protocol"

const REPLAY_PAGE_SIZE = 500
const REPLAY_MAX_GAP_MS = 3000

type ReplayPublishedEvent = ReplayStartedEvent | ReplayStoppedEvent | ReplayPausedEvent | ReplayFinishedEvent
type ReplaySnapshotEvent = ReplayStartedEvent | ReplayPausedEvent | ReplayFinishedEvent

export interface ReplayPublisher {
  publish(topic: string, data: string): unknown
}

interface ActiveReplayState {
  readonly sessionId: number
  readonly sessionName: string
  readonly kind: LogSessionKind
  readonly devices: readonly LogDeviceSummary[]
  readonly startedAtMs: number | null
  readonly audioSchedule: GnauralScheduleData | null
  readonly audioScheduleStartedAtMs: number | null
  readonly audioFileContent: string | null
  readonly playbackId: number
  speed: ReplaySpeed
  cursorTimestampMs: number | null
  nextCursor: number
  previousTimestampMs: number | null
  paused: boolean
  finished: boolean
  stopRequested: boolean
}

export interface ReplayStartResult {
  readonly ok: boolean
  readonly error?: string
}

export interface LogReplayManager {
  isActive(): boolean
  getSnapshotEvents(): readonly ReplaySnapshotEvent[]
  startReplay(server: ReplayPublisher, sessionId: number, timestampMs?: number): Promise<ReplayStartResult>
  stopReplay(server: ReplayPublisher): Promise<boolean>
  pauseReplay(server: ReplayPublisher): boolean
  seekReplay(server: ReplayPublisher, timestampMs: number): Promise<boolean>
  setReplaySpeed(server: ReplayPublisher, speed: ReplaySpeed): boolean
}

interface CreateLogReplayManagerOptions {
  readonly archiveStore: LogArchiveStore
  readonly processManager: AppSession
  readonly restoreLiveProcess: (server: ReplayPublisher) => Promise<void>
  readonly audioControl?: {
    start(audioContent: string, positionSec: number): void
    stop(): void
    pause(): void
    resume(): void
  }
}

const toReplayStartedEvent = (replayState: ActiveReplayState): ReplayStartedEvent => {
  return {
    type: "replay_started",
    sessionId: replayState.sessionId,
    sessionName: replayState.sessionName,
    kind: replayState.kind,
    devices: replayState.devices,
    speed: replayState.speed,
    ...(replayState.startedAtMs !== null ? { startedAtMs: replayState.startedAtMs } : {}),
    ...(replayState.audioSchedule !== null ? { audioSchedule: replayState.audioSchedule } : {}),
    ...(replayState.audioScheduleStartedAtMs !== null ? { audioScheduleStartedAtMs: replayState.audioScheduleStartedAtMs } : {}),
    ...(replayState.cursorTimestampMs !== null ? { cursorTimestampMs: replayState.cursorTimestampMs } : {}),
  }
}

const publishReplayEvent = (
  server: ReplayPublisher,
  event: ReplayPublishedEvent
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
  if (event.payload.type !== "bodymonitor_output") {
    return null
  }

  return getRuntimeEventTimestampMs(event.payload.parsedJson)
}

const toReplayPausedEvent = (replayState: ActiveReplayState): ReplayPausedEvent => {
  return {
    type: "replay_paused",
    sessionId: replayState.sessionId,
    ...(replayState.cursorTimestampMs !== null ? { cursorTimestampMs: replayState.cursorTimestampMs } : {}),
  }
}

const toReplayFinishedEvent = (sessionId: number): ReplayFinishedEvent => {
  return {
    type: "replay_finished",
    sessionId,
  }
}

export const createLogReplayManager = (
  options: CreateLogReplayManagerOptions
): LogReplayManager => {
  let nextPlaybackId = 1
  let activeReplay: ActiveReplayState | null = null

  const createReplayState = (params: {
    readonly sessionId: number
    readonly sessionName: string
    readonly kind: LogSessionKind
    readonly devices: readonly LogDeviceSummary[]
    readonly startedAtMs: number | null
    readonly audioSchedule: GnauralScheduleData | null
    readonly audioScheduleStartedAtMs: number | null
    readonly audioFileContent?: string | null
    readonly speed?: ReplaySpeed
    readonly cursorTimestampMs?: number | null
    readonly nextCursor?: number
    readonly previousTimestampMs?: number | null
    readonly paused?: boolean
  }): ActiveReplayState => {
    return {
      sessionId: params.sessionId,
      sessionName: params.sessionName,
      kind: params.kind,
      devices: params.devices,
      startedAtMs: params.startedAtMs,
      audioSchedule: params.audioSchedule,
      audioScheduleStartedAtMs: params.audioScheduleStartedAtMs,
      audioFileContent: params.audioFileContent ?? null,
      playbackId: nextPlaybackId++,
      speed: params.speed ?? 1,
      cursorTimestampMs: params.cursorTimestampMs ?? null,
      nextCursor: params.nextCursor ?? 0,
      previousTimestampMs: params.previousTimestampMs ?? null,
      paused: params.paused ?? false,
      finished: false,
      stopRequested: false,
    }
  }

  const resolveSeekPosition = (sessionId: number, timestampMs: number): {
    readonly nextCursor: number
    readonly previousTimestampMs: number
  } => {
    let cursor = 0
    let lastSeqNo = 0

    while (true) {
      const events = options.archiveStore.listSessionEvents(sessionId, cursor, REPLAY_PAGE_SIZE)
      if (events.length === 0) {
        break
      }

      for (const event of events) {
        const eventTimestampMs = getArchivedEventTimestampMs(event)
        if (eventTimestampMs !== null && eventTimestampMs >= timestampMs) {
          return {
            nextCursor: lastSeqNo,
            previousTimestampMs: timestampMs,
          }
        }

        lastSeqNo = event.seqNo
        cursor = event.seqNo
      }

      if (events.length < REPLAY_PAGE_SIZE) {
        break
      }
    }

    return {
      nextCursor: lastSeqNo,
      previousTimestampMs: timestampMs,
    }
  }

  const normalizeReplayTimestampMs = (timestampMs?: number): number | null => {
    return typeof timestampMs === "number" && Number.isFinite(timestampMs)
      ? Math.max(0, Math.round(timestampMs))
      : null
  }

  const isCurrentReplay = (replayState: ActiveReplayState): boolean => {
    return activeReplay !== null
      && activeReplay.playbackId === replayState.playbackId
      && !activeReplay.stopRequested
  }

  const waitUntilResumedOrCancelled = async (replayState: ActiveReplayState): Promise<boolean> => {
    while (isCurrentReplay(replayState) && replayState.paused) {
      await Bun.sleep(50)
    }

    return isCurrentReplay(replayState)
  }

  const restartLiveProcess = async (server: ReplayPublisher): Promise<void> => {
    try {
      await options.restoreLiveProcess(server)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to restore BodyMonitor after replay"
      server.publish("ui", toJson({ type: "bodymonitor_error", message }))
    }
  }

  const calcAudioPositionSec = (state: ActiveReplayState): number => {
    const referenceMs = state.cursorTimestampMs ?? state.startedAtMs ?? 0
    const scheduleStartMs = state.audioScheduleStartedAtMs ?? 0
    return Math.max(0, (referenceMs - scheduleStartMs) / 1000)
  }

  const startAudioIfEligible = (state: ActiveReplayState): void => {
    if (options.audioControl == null) return
    if (state.audioFileContent == null || state.audioScheduleStartedAtMs == null) return
    if (state.speed !== 1 || state.paused || state.finished) return
    options.audioControl.start(state.audioFileContent, calcAudioPositionSec(state))
  }

  const stopAudio = (): void => {
    options.audioControl?.stop()
  }

  const waitWithCancellation = async (
    server: ReplayPublisher,
    replayState: ActiveReplayState,
    waitDelayMs: number,
    targetTimestampMs: number,
  ): Promise<boolean> => {
    const startTimestampMs = replayState.previousTimestampMs
    const normalizedWaitDelayMs = Math.max(0, Math.trunc(waitDelayMs))
    const totalTimelineAdvanceMs = startTimestampMs === null
      ? 0
      : Math.max(0, targetTimestampMs - startTimestampMs)
    let remainingWaitDelayMs = normalizedWaitDelayMs

    while (remainingWaitDelayMs > 0) {
      if (!await waitUntilResumedOrCancelled(replayState)) {
        return false
      }

      const currentSpeed = replayState.speed
      const sleepSliceMs = Math.min(Math.max(remainingWaitDelayMs / currentSpeed, 1), 100)
      await Bun.sleep(sleepSliceMs)

      const advancedWaitDelayMs = Math.min(remainingWaitDelayMs, sleepSliceMs * currentSpeed)
      remainingWaitDelayMs = Math.max(0, remainingWaitDelayMs - advancedWaitDelayMs)

      if (startTimestampMs !== null && normalizedWaitDelayMs > 0 && totalTimelineAdvanceMs > 0) {
        const completedRatio = Math.max(0, Math.min(1, (normalizedWaitDelayMs - remainingWaitDelayMs) / normalizedWaitDelayMs))
        const interpolatedTimestampMs = Math.min(
          targetTimestampMs,
          startTimestampMs + Math.round(totalTimelineAdvanceMs * completedRatio),
        )

        replayState.cursorTimestampMs = interpolatedTimestampMs
        replayState.previousTimestampMs = interpolatedTimestampMs
        publishReplayProgress(server, replayState)
      }
    }

    return waitUntilResumedOrCancelled(replayState)
  }

  const runPlayback = async (
    server: ReplayPublisher,
    replayState: ActiveReplayState,
  ): Promise<void> => {
    try {
      while (isCurrentReplay(replayState)) {
        if (!await waitUntilResumedOrCancelled(replayState)) {
          return
        }

        const events = options.archiveStore.listSessionEvents(replayState.sessionId, replayState.nextCursor, REPLAY_PAGE_SIZE)
        if (events.length === 0) {
          break
        }

        for (const event of events) {
          if (!await waitUntilResumedOrCancelled(replayState)) {
            return
          }

          const eventTimestampMs = getArchivedEventTimestampMs(event)
          if (replayState.previousTimestampMs !== null && eventTimestampMs !== null) {
            const rawDelayMs = Math.max(0, eventTimestampMs - replayState.previousTimestampMs)
            const waitDelayMs = Math.min(rawDelayMs, REPLAY_MAX_GAP_MS)
            if (!await waitWithCancellation(server, replayState, waitDelayMs, eventTimestampMs)) {
              return
            }
          }

          publishArchivedEvent(server, event)
          if (eventTimestampMs !== null) {
            replayState.cursorTimestampMs = eventTimestampMs
            replayState.previousTimestampMs = eventTimestampMs
            publishReplayProgress(server, replayState)
          }
          replayState.nextCursor = event.seqNo
        }

        if (events.length < REPLAY_PAGE_SIZE) {
          break
        }

        await Bun.sleep(0)
      }

      if (isCurrentReplay(replayState)) {
        replayState.finished = true
        stopAudio()
        publishReplayEvent(server, toReplayFinishedEvent(replayState.sessionId))
      }
    } catch (error) {
      if (!isCurrentReplay(replayState)) {
        return
      }

      const failedSessionId = replayState.sessionId
      stopAudio()
      const message = error instanceof Error ? error.message : "Replay failed"
      server.publish("ui", toJson({ type: "bodymonitor_error", message }))
      publishReplayEvent(server, {
        type: "replay_stopped",
        sessionId: failedSessionId,
      })
      activeReplay = null
      await restartLiveProcess(server)
    }
  }

  return {
    isActive(): boolean {
      return activeReplay !== null
    },

    getSnapshotEvents(): readonly ReplaySnapshotEvent[] {
      if (activeReplay === null) {
        return []
      }

      const snapshotEvents: ReplaySnapshotEvent[] = [toReplayStartedEvent(activeReplay)]

      if (activeReplay.finished) {
        snapshotEvents.push(toReplayFinishedEvent(activeReplay.sessionId))
      } else if (activeReplay.paused) {
        snapshotEvents.push(toReplayPausedEvent(activeReplay))
      }

      return snapshotEvents
    },

    async startReplay(server: ReplayPublisher, sessionId: number, timestampMs?: number): Promise<ReplayStartResult> {
      const currentReplay = activeReplay
      const startTimestampMs = normalizeReplayTimestampMs(timestampMs)

      const session = options.archiveStore.getSession(sessionId)
      if (session === null) {
        return { ok: false, error: "Archived log not found" }
      }

      const firstPage = options.archiveStore.listSessionEvents(sessionId, 0, 1)
      if (firstPage.length === 0) {
        return { ok: false, error: "Archived log has no events to replay" }
      }

      if (currentReplay !== null && currentReplay.sessionId === sessionId && !currentReplay.finished && startTimestampMs === null) {
        currentReplay.stopRequested = true

        const resumedReplay = createReplayState({
          sessionId: currentReplay.sessionId,
          sessionName: currentReplay.sessionName,
          kind: currentReplay.kind,
          devices: currentReplay.devices,
          startedAtMs: currentReplay.startedAtMs,
          audioSchedule: currentReplay.audioSchedule,
          audioScheduleStartedAtMs: currentReplay.audioScheduleStartedAtMs,
          audioFileContent: currentReplay.audioFileContent,
          speed: currentReplay.speed,
          cursorTimestampMs: currentReplay.cursorTimestampMs,
          nextCursor: currentReplay.nextCursor,
          previousTimestampMs: currentReplay.previousTimestampMs,
          paused: false,
        })

        activeReplay = resumedReplay
        stopAudio()
        startAudioIfEligible(resumedReplay)
        publishReplayEvent(server, toReplayStartedEvent(resumedReplay))
        void runPlayback(server, resumedReplay)
        return { ok: true }
      }

      if (currentReplay === null) {
        if (options.archiveStore.hasActiveSession()) {
          return { ok: false, error: "Stop the active scan or monitoring session before replay" }
        }

        const processState = options.processManager.getState()
        if (processState.sessionState !== "idle") {
          return { ok: false, error: "Stop the active scan or monitoring session before replay" }
        }
      } else {
        currentReplay.stopRequested = true
        stopAudio()
        if (currentReplay.sessionId !== sessionId || !currentReplay.finished) {
          publishReplayEvent(server, {
            type: "replay_stopped",
            sessionId: currentReplay.sessionId,
          })
        }
      }

      const seekPosition = startTimestampMs !== null ? resolveSeekPosition(sessionId, startTimestampMs) : null

      activeReplay = createReplayState({
        sessionId,
        sessionName: session.effectiveName,
        kind: session.kind,
        devices: session.deviceSummary,
        startedAtMs: Number.isFinite(Date.parse(session.startedAt)) ? Date.parse(session.startedAt) : null,
        audioSchedule: session.audioSchedule ?? null,
        audioScheduleStartedAtMs: session.audioScheduleStartedAtMs ?? null,
        audioFileContent: options.archiveStore.getSessionAudioFileContent(sessionId),
        cursorTimestampMs: startTimestampMs,
        nextCursor: seekPosition?.nextCursor,
        previousTimestampMs: seekPosition?.previousTimestampMs,
      })

      publishReplayEvent(server, toReplayStartedEvent(activeReplay))
      startAudioIfEligible(activeReplay)

      void runPlayback(server, activeReplay)
      return { ok: true }
    },

    async stopReplay(server: ReplayPublisher): Promise<boolean> {
      if (activeReplay === null) {
        return false
      }

      const sessionId = activeReplay.sessionId
      activeReplay.stopRequested = true
      stopAudio()
      activeReplay = null

      publishReplayEvent(server, {
        type: "replay_stopped",
        sessionId,
      })

      await restartLiveProcess(server)
      return true
    },

    pauseReplay(server: ReplayPublisher): boolean {
      if (activeReplay === null || activeReplay.finished) {
        return false
      }

      activeReplay.paused = true
      options.audioControl?.pause()
      publishReplayEvent(server, toReplayPausedEvent(activeReplay))
      return true
    },

    async seekReplay(server: ReplayPublisher, timestampMs: number): Promise<boolean> {
      const currentReplay = activeReplay
      if (currentReplay === null) {
        return false
      }

      const session = options.archiveStore.getSession(currentReplay.sessionId)
      if (session === null) {
        return false
      }

      currentReplay.stopRequested = true
      stopAudio()
      const seekPosition = resolveSeekPosition(currentReplay.sessionId, timestampMs)

      activeReplay = createReplayState({
        sessionId: currentReplay.sessionId,
        sessionName: session.effectiveName,
        kind: session.kind,
        devices: session.deviceSummary,
        startedAtMs: Number.isFinite(Date.parse(session.startedAt)) ? Date.parse(session.startedAt) : null,
        audioSchedule: session.audioSchedule ?? null,
        audioScheduleStartedAtMs: session.audioScheduleStartedAtMs ?? null,
        audioFileContent: currentReplay.audioFileContent,
        speed: currentReplay.speed,
        cursorTimestampMs: timestampMs,
        nextCursor: seekPosition.nextCursor,
        previousTimestampMs: seekPosition.previousTimestampMs,
        paused: currentReplay.paused,
      })

      publishReplayEvent(server, toReplayStartedEvent(activeReplay))
      if (activeReplay.paused) {
        publishReplayEvent(server, toReplayPausedEvent(activeReplay))
      }
      startAudioIfEligible(activeReplay)

      void runPlayback(server, activeReplay)
      return true
    },

    setReplaySpeed(server: ReplayPublisher, speed: ReplaySpeed): boolean {
      if (activeReplay === null) {
        return false
      }

      activeReplay.speed = speed
      if (speed === 1) {
        startAudioIfEligible(activeReplay)
      } else {
        stopAudio()
      }
      publishReplayProgress(server, activeReplay)
      return true
    },
  }
}
