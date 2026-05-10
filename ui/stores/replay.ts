import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  ArchivedLogChartData,
  BodyMonitorOutputEvent,
  BodyMonitorServerEvent,
  DeviceInfo,
  GnauralScheduleData,
  LogDeviceSummary,
  LogSessionKind,
  ReplayFinishedEvent,
  ReplayPausedEvent,
  ReplayProgressEvent,
  ReplaySpeed,
  ReplayStartedEvent,
  ReplayStoppedEvent,
} from '@protocol'
import { getRuntimeEventTimestampMs } from '@protocol'
import { wsService } from 'src/services/ws'
import { logsApi } from 'src/services/logs-api'

const RAW_LINES_MAX = 1000
const REPLAY_DEVICE_LABEL_MAC_PATTERN = /\[([^\]]+)\]/
const REPLAY_CONTROL_UNAVAILABLE_ERROR = 'Replay control connection is unavailable.'

type DeviceConnectionState = 'online' | 'offline'
type ReplayLifecycleStatus = 'playing' | 'paused' | 'stopped' | 'finished' | null

interface ReplayStartWaiter {
  readonly sessionId: number
  readonly resolve: (started: boolean) => void
  readonly timeoutHandle: ReturnType<typeof setTimeout>
}

interface ReplaySessionState {
  readonly sessionId: number
  sessionName: string
  kind: LogSessionKind | null
  status: ReplayLifecycleStatus
  speed: ReplaySpeed
  cursorTimestampMs: number | null
  sessionStartMs: number | null
  audioSchedule: GnauralScheduleData | null
  audioScheduleStartedAtMs: number | null
  rawLines: string[]
  selectedDevices: LogDeviceSummary[]
  discoveredDevices: DeviceInfo[]
  deviceConnectionStates: Record<string, DeviceConnectionState>
  error: string | null
  chartData: ArchivedLogChartData | null
  chartLoading: boolean
  chartError: string | null
  chartRequestToken: number
  pendingSeek: boolean
  startPending: boolean
  stopRequested: boolean
  transportActive: boolean
}

export interface ReplayPreparedSessionSummary {
  readonly sessionId: number
  readonly sessionName: string
  readonly kind: LogSessionKind | null
  readonly status: ReplayLifecycleStatus
  readonly startPending: boolean
  readonly transportActive: boolean
  readonly hasError: boolean
}

export interface ReplaySessionViewState {
  readonly sessionId: number
  readonly sessionName: string
  readonly kind: LogSessionKind | null
  readonly status: ReplayLifecycleStatus
  readonly speed: ReplaySpeed
  readonly cursorTimestampMs: number | null
  readonly sessionStartMs: number | null
  readonly audioSchedule: GnauralScheduleData | null
  readonly audioScheduleStartedAtMs: number | null
  readonly rawLines: readonly string[]
  readonly selectedDevices: readonly LogDeviceSummary[]
  readonly discoveredDevices: readonly DeviceInfo[]
  readonly deviceConnectionStates: Readonly<Record<string, DeviceConnectionState>>
  readonly error: string | null
  readonly chartData: ArchivedLogChartData | null
  readonly chartLoading: boolean
  readonly chartError: string | null
  readonly startPending: boolean
  readonly transportActive: boolean
}

const EMPTY_RAW_LINES: readonly string[] = []
const EMPTY_SELECTED_DEVICES: readonly LogDeviceSummary[] = []
const EMPTY_DISCOVERED_DEVICES: readonly DeviceInfo[] = []
const EMPTY_DEVICE_STATES: Readonly<Record<string, DeviceConnectionState>> = {}

function createReplaySessionState(params: {
  readonly sessionId: number
  readonly sessionName: string
  readonly kind: LogSessionKind
  readonly audioSchedule: GnauralScheduleData | null
  readonly audioScheduleStartedAtMs: number | null
  readonly sessionStartMs: number | null
}): ReplaySessionState {
  return {
    sessionId: params.sessionId,
    sessionName: params.sessionName,
    kind: params.kind,
    status: null,
    speed: 1,
    cursorTimestampMs: null,
    sessionStartMs: params.sessionStartMs,
    audioSchedule: params.audioSchedule,
    audioScheduleStartedAtMs: params.audioScheduleStartedAtMs,
    rawLines: [],
    selectedDevices: [],
    discoveredDevices: [],
    deviceConnectionStates: {},
    error: null,
    chartData: null,
    chartLoading: false,
    chartError: null,
    chartRequestToken: 0,
    pendingSeek: false,
    startPending: false,
    stopRequested: false,
    transportActive: false,
  }
}

function markReplayCommandUnavailable(session: ReplaySessionState): void {
  session.startPending = false
  session.stopRequested = false
  session.transportActive = false
  session.error = REPLAY_CONTROL_UNAVAILABLE_ERROR
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseRuntimeDeviceState(value: unknown): { readonly mac: string; readonly state: DeviceConnectionState } | null {
  if (!isRecord(value)) {
    return null
  }

  const event = typeof value.event === 'string' ? value.event : ''
  const mac = typeof value.mac === 'string' ? value.mac : ''
  const state = typeof value.state === 'string' ? value.state : ''
  const source = typeof value.source === 'string' ? value.source : ''

  if (event !== 'ble_connection' || source !== 'ecg' || mac === '') {
    return null
  }

  if (state !== 'online' && state !== 'offline') {
    return null
  }

  return { mac, state }
}

function getReplayDeviceStateKeys(deviceIdentifier: string): readonly string[] {
  const trimmedIdentifier = deviceIdentifier.trim()
  if (trimmedIdentifier === '') {
    return []
  }

  const keys = [trimmedIdentifier]
  const macMatch = trimmedIdentifier.match(REPLAY_DEVICE_LABEL_MAC_PATTERN)
  const archivedMac = macMatch?.[1]?.trim()

  if (archivedMac && archivedMac !== trimmedIdentifier) {
    keys.push(archivedMac)
  }

  return keys
}

function toReplaySessionViewState(session: ReplaySessionState): ReplaySessionViewState {
  return {
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    kind: session.kind,
    status: session.status,
    speed: session.speed,
    cursorTimestampMs: session.cursorTimestampMs,
    sessionStartMs: session.sessionStartMs,
    audioSchedule: session.audioSchedule,
    audioScheduleStartedAtMs: session.audioScheduleStartedAtMs,
    rawLines: session.rawLines,
    selectedDevices: session.selectedDevices,
    discoveredDevices: session.discoveredDevices,
    deviceConnectionStates: session.deviceConnectionStates,
    error: session.error,
    chartData: session.chartData,
    chartLoading: session.chartLoading,
    chartError: session.chartError,
    startPending: session.startPending,
    transportActive: session.transportActive,
  }
}

export const useReplayStore = defineStore('replay', () => {
  const replaySessions = ref<Record<number, ReplaySessionState>>({})
  const replaySessionOrder = ref<number[]>([])
  const activeReplaySessionId = ref<number | null>(null)

  let replayStartWaiters: ReplayStartWaiter[] = []
  const ignoredClosedReplaySessionIds = new Set<number>()

  const activeReplaySession = computed(() => {
    if (activeReplaySessionId.value === null) {
      return null
    }

    return replaySessions.value[activeReplaySessionId.value] ?? null
  })

  const isReplayMode = computed(() => activeReplaySession.value !== null)
  const isReplayTransportActive = computed(() => activeReplaySession.value?.transportActive ?? false)
  const isReplayErrorRoutingActive = computed(() => {
    const session = activeReplaySession.value
    if (session === null) {
      return false
    }

    return session.transportActive || session.startPending
  })

  const replaySessionId = computed(() => activeReplaySession.value?.sessionId ?? null)
  const replaySessionName = computed(() => activeReplaySession.value?.sessionName ?? '')
  const replayKind = computed(() => activeReplaySession.value?.kind ?? null)
  const replayStatus = computed<ReplayLifecycleStatus>(() => activeReplaySession.value?.status ?? null)
  const replaySpeed = computed<ReplaySpeed>(() => activeReplaySession.value?.speed ?? 1)
  const replayCursorTimestampMs = computed(() => activeReplaySession.value?.cursorTimestampMs ?? null)
  const replaySessionStartMs = computed(() => activeReplaySession.value?.sessionStartMs ?? null)
  const replayAudioSchedule = computed(() => activeReplaySession.value?.audioSchedule ?? null)
  const replayAudioScheduleStartedAtMs = computed(() => activeReplaySession.value?.audioScheduleStartedAtMs ?? null)
  const replayRawLines = computed(() => activeReplaySession.value?.rawLines ?? EMPTY_RAW_LINES)
  const replaySelectedDevices = computed(() => activeReplaySession.value?.selectedDevices ?? EMPTY_SELECTED_DEVICES)
  const replayDiscoveredDevices = computed(() => activeReplaySession.value?.discoveredDevices ?? EMPTY_DISCOVERED_DEVICES)
  const replayDeviceConnectionStates = computed(() => activeReplaySession.value?.deviceConnectionStates ?? EMPTY_DEVICE_STATES)
  const replayError = computed(() => activeReplaySession.value?.error ?? null)
  const replayChartData = computed(() => activeReplaySession.value?.chartData ?? null)
  const replayChartLoading = computed(() => activeReplaySession.value?.chartLoading ?? false)
  const replayChartError = computed(() => activeReplaySession.value?.chartError ?? null)

  const replayPreparedSessions = computed<ReplayPreparedSessionSummary[]>(() => {
    const result: ReplayPreparedSessionSummary[] = []

    for (const sessionId of replaySessionOrder.value) {
      const session = replaySessions.value[sessionId]
      if (session === undefined) {
        continue
      }

      result.push({
        sessionId: session.sessionId,
        sessionName: session.sessionName,
        kind: session.kind,
        status: session.status,
        startPending: session.startPending,
        transportActive: session.transportActive,
        hasError: session.error !== null || session.chartError !== null,
      })
    }

    return result
  })

  function getReplaySessionInternal(sessionId: number): ReplaySessionState | null {
    return replaySessions.value[sessionId] ?? null
  }

  function getReplaySessionState(sessionId: number): ReplaySessionViewState | null {
    const session = getReplaySessionInternal(sessionId)
    if (session === null) {
      return null
    }

    return toReplaySessionViewState(session)
  }

  function isReplaySessionPrepared(sessionId: number): boolean {
    return getReplaySessionInternal(sessionId) !== null
  }

  function ensureReplaySession(params: {
    readonly sessionId: number
    readonly sessionName: string
    readonly kind: LogSessionKind
    readonly audioSchedule: GnauralScheduleData | null
    readonly audioScheduleStartedAtMs: number | null
    readonly sessionStartMs: number | null
  }): ReplaySessionState {
    const existing = getReplaySessionInternal(params.sessionId)
    if (existing !== null) {
      existing.sessionName = params.sessionName
      existing.kind = params.kind
      existing.audioSchedule = params.audioSchedule
      existing.audioScheduleStartedAtMs = params.audioScheduleStartedAtMs
      existing.sessionStartMs = params.sessionStartMs
      return existing
    }

    const nextSession = createReplaySessionState(params)
    replaySessions.value = {
      ...replaySessions.value,
      [params.sessionId]: nextSession,
    }
    replaySessionOrder.value = [...replaySessionOrder.value, params.sessionId]
    return nextSession
  }

  function removeReplaySession(sessionId: number) {
    const nextSessions = { ...replaySessions.value }
    delete nextSessions[sessionId]
    replaySessions.value = nextSessions
    replaySessionOrder.value = replaySessionOrder.value.filter((id) => id !== sessionId)
  }

  function clearReplayBuffers(session: ReplaySessionState) {
    session.pendingSeek = false
    session.rawLines = []
    session.discoveredDevices = []
    session.deviceConnectionStates = {}
    session.cursorTimestampMs = null
    session.sessionStartMs = null
    session.audioSchedule = null
    session.audioScheduleStartedAtMs = null
    session.error = null
    session.chartData = null
    session.chartLoading = false
    session.chartError = null
    session.selectedDevices = []
    session.speed = 1
    session.status = null
    session.startPending = false
    session.stopRequested = false
    session.transportActive = false
  }

  function clearReplayTransientState(session: ReplaySessionState) {
    session.rawLines = []
    session.discoveredDevices = []
    session.deviceConnectionStates = {}
    session.error = null
  }

  async function loadReplayChartData(sessionId: number) {
    const session = getReplaySessionInternal(sessionId)
    if (session === null) {
      return
    }

    const requestToken = ++session.chartRequestToken
    session.chartLoading = true
    session.chartError = null

    try {
      const chartData = await logsApi.fetchLogChart(sessionId)
      const currentSession = getReplaySessionInternal(sessionId)
      if (currentSession === null || currentSession.chartRequestToken !== requestToken) {
        return
      }

      currentSession.chartData = chartData
    } catch (error) {
      const currentSession = getReplaySessionInternal(sessionId)
      if (currentSession === null || currentSession.chartRequestToken !== requestToken) {
        return
      }

      currentSession.chartError = error instanceof Error ? error.message : 'Failed to load chart data'
    } finally {
      const currentSession = getReplaySessionInternal(sessionId)
      if (currentSession !== null && currentSession.chartRequestToken === requestToken) {
        currentSession.chartLoading = false
      }
    }
  }

  function settleReplayStartWaiters(sessionId: number, started: boolean) {
    const pendingWaiters = replayStartWaiters
    replayStartWaiters = []

    for (const waiter of pendingWaiters) {
      if (waiter.sessionId !== sessionId) {
        replayStartWaiters.push(waiter)
        continue
      }

      clearTimeout(waiter.timeoutHandle)
      waiter.resolve(started)
    }
  }

  function settleAllReplayStartWaiters(started: boolean) {
    const pendingWaiters = replayStartWaiters
    replayStartWaiters = []

    for (const waiter of pendingWaiters) {
      clearTimeout(waiter.timeoutHandle)
      waiter.resolve(started)
    }
  }

  function activateReplaySession(sessionId: number | null): boolean {
    if (sessionId === null) {
      activeReplaySessionId.value = null
      return true
    }

    if (getReplaySessionInternal(sessionId) === null) {
      return false
    }

    ignoredClosedReplaySessionIds.delete(sessionId)
    activeReplaySessionId.value = sessionId
    return true
  }

  function clearReplayState() {
    replaySessions.value = {}
    replaySessionOrder.value = []
    activeReplaySessionId.value = null
    ignoredClosedReplaySessionIds.clear()
    settleAllReplayStartWaiters(false)
  }

  function clearRawLines() {
    const session = activeReplaySession.value
    if (session === null) {
      return
    }

    session.rawLines = []
  }

  function prepareReplay(
    sessionId: number,
    sessionName: string,
    sessionKind: LogSessionKind,
    audioSchedule: GnauralScheduleData | null = null,
    audioScheduleStartedAtMs: number | null = null,
    sessionStartedAtMs: number | null = null,
  ): void {
    ignoredClosedReplaySessionIds.delete(sessionId)
    const session = ensureReplaySession({
      sessionId,
      sessionName,
      kind: sessionKind,
      audioSchedule,
      audioScheduleStartedAtMs,
      sessionStartMs: sessionStartedAtMs,
    })

    session.stopRequested = false

    if (session.chartData === null && !session.chartLoading) {
      void loadReplayChartData(sessionId)
    }

    activeReplaySessionId.value = sessionId
  }

  function startReplay(sessionId: number, timestampMs?: number): boolean {
    const session = getReplaySessionInternal(sessionId)
    if (session === null) {
      return false
    }

    activeReplaySessionId.value = sessionId

    if (!wsService.send({ type: 'replay_start', sessionId, ...(timestampMs !== undefined ? { timestampMs } : {}) })) {
      markReplayCommandUnavailable(session)
      return false
    }

    session.startPending = true
    session.stopRequested = false
    session.error = null
    return true
  }

  function startReplayAndWait(sessionId: number, timeoutMs = 3000, timestampMs?: number): Promise<boolean> {
    const session = getReplaySessionInternal(sessionId)
    if (session === null) {
      return Promise.resolve(false)
    }

    activeReplaySessionId.value = sessionId

    if (!wsService.send({ type: 'replay_start', sessionId, ...(timestampMs !== undefined ? { timestampMs } : {}) })) {
      markReplayCommandUnavailable(session)
      return Promise.resolve(false)
    }

    session.startPending = true
    session.stopRequested = false
    session.error = null

    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        replayStartWaiters = replayStartWaiters.filter((waiter) => waiter.timeoutHandle !== timeoutHandle)
        const currentSession = getReplaySessionInternal(sessionId)
        resolve(currentSession !== null && currentSession.transportActive)
      }, timeoutMs)

      replayStartWaiters.push({
        sessionId,
        resolve,
        timeoutHandle,
      })
    })
  }

  function stopReplay(): boolean {
    const session = activeReplaySession.value
    if (session === null) {
      clearReplayState()
      return true
    }

    if (!session.transportActive && !session.startPending && session.status === null) {
      clearReplayState()
      return true
    }

    const sent = wsService.send({ type: 'replay_stop' })
    if (sent) {
      session.startPending = false
      session.stopRequested = true
    }

    return sent
  }

  function pauseReplay(): boolean {
    const session = activeReplaySession.value
    if (session === null) {
      return false
    }

    if (!wsService.send({ type: 'replay_pause' })) {
      return false
    }

    session.status = 'paused'
    return true
  }

  function pauseReplaySession(sessionId: number): boolean {
    const session = getReplaySessionInternal(sessionId)
    if (session === null) {
      return false
    }

    if (activeReplaySessionId.value !== sessionId) {
      return true
    }

    if (session.status === 'playing') {
      return pauseReplay()
    }

    if (session.startPending) {
      const sent = wsService.send({ type: 'replay_stop' })
      if (sent) {
        session.startPending = false
        session.stopRequested = true
      }

      return sent
    }

    return true
  }

  function pauseActiveReplay(): boolean {
    if (activeReplaySessionId.value === null) {
      return true
    }

    return pauseReplaySession(activeReplaySessionId.value)
  }

  function seekReplay(timestampMs: number): boolean {
    const session = activeReplaySession.value
    if (session === null) {
      return false
    }

    const canSeekCurrentSession = session.transportActive
      || session.status === 'playing'
      || session.status === 'paused'
      || session.status === 'finished'

    if (!canSeekCurrentSession || session.startPending) {
      return false
    }

    if (!wsService.send({ type: 'replay_seek', timestampMs })) {
      return false
    }

    session.pendingSeek = true
    session.cursorTimestampMs = timestampMs
    return true
  }

  function setReplaySpeed(speed: ReplaySpeed): boolean {
    const session = activeReplaySession.value
    if (session === null) {
      return false
    }

    if (!wsService.send({ type: 'replay_set_speed', speed })) {
      return false
    }

    session.speed = speed
    return true
  }

  function setReplaySessionError(sessionId: number, error: string | null): boolean {
    const session = getReplaySessionInternal(sessionId)
    if (session === null) {
      return false
    }

    session.error = error
    return true
  }

  function closeReplaySession(sessionId: number): boolean {
    const session = getReplaySessionInternal(sessionId)
    if (session === null) {
      return false
    }

    const isActiveSession = activeReplaySessionId.value === sessionId
    const shouldStopTransport = isActiveSession && (session.transportActive || session.startPending || session.status === 'playing')

    ignoredClosedReplaySessionIds.delete(sessionId)
    if (shouldStopTransport) {
      ignoredClosedReplaySessionIds.add(sessionId)
      void wsService.send({ type: 'replay_stop' })
    }

    settleReplayStartWaiters(sessionId, false)
    removeReplaySession(sessionId)

    if (isActiveSession) {
      activeReplaySessionId.value = null
    }

    return true
  }

  function handleReplayStarted(event: ReplayStartedEvent) {
    const existingSession = getReplaySessionInternal(event.sessionId)
    if (existingSession === null && ignoredClosedReplaySessionIds.has(event.sessionId)) {
      void wsService.send({ type: 'replay_stop' })
      return
    }

    ignoredClosedReplaySessionIds.delete(event.sessionId)

    const previousActiveSessionId = activeReplaySessionId.value
    if (previousActiveSessionId !== null && previousActiveSessionId !== event.sessionId) {
      const previousSession = getReplaySessionInternal(previousActiveSessionId)
      if (previousSession !== null) {
        previousSession.transportActive = false
        previousSession.startPending = false
        if (previousSession.status === 'playing') {
          previousSession.status = 'paused'
        }
      }
    }

    const session = ensureReplaySession({
      sessionId: event.sessionId,
      sessionName: event.sessionName,
      kind: event.kind,
      audioSchedule: event.audioSchedule ?? null,
      audioScheduleStartedAtMs: event.audioScheduleStartedAtMs ?? null,
      sessionStartMs: event.startedAtMs ?? null,
    })

    const shouldStopReplay = session.stopRequested

    activeReplaySessionId.value = event.sessionId
    session.transportActive = true
    session.startPending = false
    session.stopRequested = false
    session.status = 'playing'

    clearReplayTransientState(session)
    if (session.pendingSeek) {
      session.pendingSeek = false
    }

    session.speed = event.speed
    session.sessionStartMs = event.startedAtMs ?? session.sessionStartMs
    session.audioSchedule = event.audioSchedule ?? session.audioSchedule
    session.audioScheduleStartedAtMs = event.audioScheduleStartedAtMs ?? session.audioScheduleStartedAtMs
    session.cursorTimestampMs = event.cursorTimestampMs ?? null
    session.selectedDevices = [...event.devices]
    session.error = null

    settleReplayStartWaiters(event.sessionId, true)

    if (session.chartData === null && !session.chartLoading) {
      void loadReplayChartData(event.sessionId)
    }

    if (shouldStopReplay) {
      void wsService.send({ type: 'replay_stop' })
    }
  }

  function handleReplayStopped(event: ReplayStoppedEvent) {
    if (ignoredClosedReplaySessionIds.delete(event.sessionId)) {
      if (activeReplaySessionId.value === event.sessionId) {
        activeReplaySessionId.value = null
      }

      return
    }

    const session = getReplaySessionInternal(event.sessionId)
    if (session === null) {
      return
    }

    session.startPending = false
    session.stopRequested = false
    session.transportActive = false
    session.status = 'stopped'
  }

  function handleReplayPaused(event: ReplayPausedEvent) {
    if (ignoredClosedReplaySessionIds.has(event.sessionId) && getReplaySessionInternal(event.sessionId) === null) {
      return
    }

    const session = getReplaySessionInternal(event.sessionId)
    if (session === null) {
      return
    }

    session.transportActive = true
    session.startPending = false
    session.status = 'paused'
    session.cursorTimestampMs = event.cursorTimestampMs ?? session.cursorTimestampMs
  }

  function handleReplayFinished(event: ReplayFinishedEvent) {
    if (ignoredClosedReplaySessionIds.delete(event.sessionId)) {
      return
    }

    const session = getReplaySessionInternal(event.sessionId)
    if (session === null) {
      return
    }

    session.transportActive = false
    session.startPending = false
    session.status = 'finished'
  }

  function handleReplayProgress(event: ReplayProgressEvent) {
    if (ignoredClosedReplaySessionIds.has(event.sessionId) && getReplaySessionInternal(event.sessionId) === null) {
      return
    }

    const session = getReplaySessionInternal(event.sessionId)
    if (session === null) {
      return
    }

    session.transportActive = true
    session.startPending = false
    session.status = 'playing'
    session.speed = event.speed
    session.cursorTimestampMs = event.cursorTimestampMs ?? session.cursorTimestampMs
  }

  function handleOutput(session: ReplaySessionState, event: BodyMonitorOutputEvent) {
    session.rawLines.push(event.line)
    if (session.rawLines.length > RAW_LINES_MAX) {
      session.rawLines = session.rawLines.slice(-RAW_LINES_MAX)
    }

    const runtimeTimestampMs = getRuntimeEventTimestampMs(event.parsedJson)
    if (runtimeTimestampMs !== null) {
      session.cursorTimestampMs = runtimeTimestampMs
    }

    const runtimeDeviceState = parseRuntimeDeviceState(event.parsedJson)
    if (runtimeDeviceState !== null) {
      session.deviceConnectionStates = {
        ...session.deviceConnectionStates,
        [runtimeDeviceState.mac]: runtimeDeviceState.state,
      }
    }
  }

  function handleReplayEvent(event: BodyMonitorServerEvent) {
    const session = activeReplaySession.value
    if (session === null) {
      return
    }

    switch (event.type) {
      case 'bodymonitor_output':
        handleOutput(session, event)
        break
      case 'bodymonitor_device':
        session.discoveredDevices = [...session.discoveredDevices, event.device]
        break
      case 'bodymonitor_devices':
        session.discoveredDevices = [...event.devices]
        break
      case 'bodymonitor_error':
        session.startPending = false
        session.error = event.message
        break
    }
  }

  function getSelectedDeviceLabel(capability: string): string | null {
    const session = activeReplaySession.value
    if (session === null) {
      return null
    }

    return session.selectedDevices.find((device) => device.capability === capability)?.label ?? null
  }

  function getDeviceConnectionState(deviceIdentifier: string | null): DeviceConnectionState | null {
    if (deviceIdentifier === null) {
      return null
    }

    const states = activeReplaySession.value?.deviceConnectionStates
    if (states === undefined) {
      return null
    }

    for (const key of getReplayDeviceStateKeys(deviceIdentifier)) {
      const state = states[key]
      if (state !== undefined) {
        return state
      }
    }

    return null
  }

  function isDeviceOffline(deviceIdentifier: string | null): boolean {
    return getDeviceConnectionState(deviceIdentifier) === 'offline'
  }

  return {
    isReplayMode,
    isReplayTransportActive,
    isReplayErrorRoutingActive,
    replaySessionId,
    replaySessionName,
    replayKind,
    replayStatus,
    replaySpeed,
    replayCursorTimestampMs,
    replaySessionStartMs,
    replayAudioSchedule,
    replayAudioScheduleStartedAtMs,
    replayRawLines,
    replaySelectedDevices,
    replayDiscoveredDevices,
    replayDeviceConnectionStates,
    replayError,
    replayChartData,
    replayChartLoading,
    replayChartError,
    replayPreparedSessions,
    activeReplaySessionId,
    clearReplayState,
    clearRawLines,
    startReplay,
    prepareReplay,
    startReplayAndWait,
    stopReplay,
    pauseReplay,
    pauseActiveReplay,
    pauseReplaySession,
    seekReplay,
    setReplaySpeed,
    setReplaySessionError,
    activateReplaySession,
    closeReplaySession,
    isReplaySessionPrepared,
    getReplaySessionState,
    handleReplayStarted,
    handleReplayPaused,
    handleReplayProgress,
    handleReplayStopped,
    handleReplayFinished,
    handleReplayEvent,
    getSelectedDeviceLabel,
    getDeviceConnectionState,
    isDeviceOffline,
  }
})