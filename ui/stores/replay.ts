import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  ArchivedLogChartData,
  DeviceInfo,
  LogDeviceSummary,
  LogSessionKind,
  BodyMonitorOutputEvent,
  BodyMonitorServerEvent,
  ReplayFinishedEvent,
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

type DeviceConnectionState = 'online' | 'offline'

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

export const useReplayStore = defineStore('replay', () => {
  let replayChartRequestToken = 0

  const isReplayMode = ref(false)
  const replaySessionId = ref<number | null>(null)
  const replaySessionName = ref('')
  const replayKind = ref<LogSessionKind | null>(null)
  const replayStatus = ref<'playing' | 'stopped' | 'finished' | null>(null)
  const replaySpeed = ref<ReplaySpeed>(1)
  const replayCursorTimestampMs = ref<number | null>(null)
  const replayRawLines = ref<string[]>([])
  const replaySelectedDevices = ref<LogDeviceSummary[]>([])
  const replayDiscoveredDevices = ref<DeviceInfo[]>([])
  const replayDeviceConnectionStates = ref<Record<string, DeviceConnectionState>>({})
  const replayError = ref<string | null>(null)
  const replayChartData = ref<ArchivedLogChartData | null>(null)
  const replayChartLoading = ref(false)
  const replayChartError = ref<string | null>(null)

  function clearReplayBuffers() {
    replayChartRequestToken += 1
    replayRawLines.value = []
    replayDiscoveredDevices.value = []
    replayDeviceConnectionStates.value = {}
    replayCursorTimestampMs.value = null
    replayError.value = null
    replayChartData.value = null
    replayChartLoading.value = false
    replayChartError.value = null
  }

  async function loadReplayChartData(sessionId: number) {
    const requestToken = ++replayChartRequestToken
    replayChartLoading.value = true
    replayChartError.value = null

    try {
      const chartData = await logsApi.fetchLogChart(sessionId)
      if (!isReplayMode.value || replaySessionId.value !== sessionId || replayChartRequestToken !== requestToken) {
        return
      }

      replayChartData.value = chartData
    } catch (error) {
      if (!isReplayMode.value || replaySessionId.value !== sessionId || replayChartRequestToken !== requestToken) {
        return
      }

      replayChartError.value = error instanceof Error ? error.message : 'Failed to load chart data'
    } finally {
      if (replaySessionId.value === sessionId && replayChartRequestToken === requestToken) {
        replayChartLoading.value = false
      }
    }
  }

  function clearReplayState() {
    isReplayMode.value = false
    replaySessionId.value = null
    replaySessionName.value = ''
    replayKind.value = null
    replayStatus.value = null
    replaySpeed.value = 1
    replaySelectedDevices.value = []
    clearReplayBuffers()
  }

  function clearRawLines() {
    replayRawLines.value = []
  }

  function startReplay(sessionId: number): boolean {
    return wsService.send({ type: 'replay_start', sessionId })
  }

  function stopReplay(): boolean {
    return wsService.send({ type: 'replay_stop' })
  }

  function setReplaySpeed(speed: ReplaySpeed): boolean {
    if (!wsService.send({ type: 'replay_set_speed', speed })) {
      return false
    }

    replaySpeed.value = speed
    return true
  }

  function handleReplayStarted(event: ReplayStartedEvent) {
    const isSameReplaySession = isReplayMode.value && replaySessionId.value === event.sessionId

    isReplayMode.value = true
    replaySessionId.value = event.sessionId
    replaySessionName.value = event.sessionName
    replayKind.value = event.kind

    if (!isSameReplaySession) {
      replayStatus.value = 'playing'
      clearReplayBuffers()
      replaySpeed.value = event.speed
      replayCursorTimestampMs.value = event.cursorTimestampMs ?? null
      replaySelectedDevices.value = [...event.devices]
      void loadReplayChartData(event.sessionId)
      return
    }

    replaySpeed.value = event.speed
    replayCursorTimestampMs.value = event.cursorTimestampMs ?? replayCursorTimestampMs.value
    replaySelectedDevices.value = [...event.devices]

    if (replayChartData.value === null && !replayChartLoading.value) {
      void loadReplayChartData(event.sessionId)
    }
  }

  function handleReplayStopped(event: ReplayStoppedEvent) {
    if (replaySessionId.value !== null && replaySessionId.value !== event.sessionId) {
      return
    }

    clearReplayState()
  }

  function handleReplayFinished(event: ReplayFinishedEvent) {
    if (replaySessionId.value !== null && replaySessionId.value !== event.sessionId) {
      return
    }

    replayStatus.value = 'finished'
  }

  function handleReplayProgress(event: ReplayProgressEvent) {
    if (replaySessionId.value !== null && replaySessionId.value !== event.sessionId) {
      return
    }

    replaySpeed.value = event.speed
    replayCursorTimestampMs.value = event.cursorTimestampMs ?? replayCursorTimestampMs.value
  }

  function handleOutput(event: BodyMonitorOutputEvent) {
    replayRawLines.value.push(event.line)
    if (replayRawLines.value.length > RAW_LINES_MAX) {
      replayRawLines.value = replayRawLines.value.slice(-RAW_LINES_MAX)
    }

    const runtimeTimestampMs = getRuntimeEventTimestampMs(event.parsedJson)
    if (runtimeTimestampMs !== null) {
      replayCursorTimestampMs.value = runtimeTimestampMs
    }

    const runtimeDeviceState = parseRuntimeDeviceState(event.parsedJson)
    if (runtimeDeviceState !== null) {
      replayDeviceConnectionStates.value = {
        ...replayDeviceConnectionStates.value,
        [runtimeDeviceState.mac]: runtimeDeviceState.state,
      }
    }
  }

  function handleReplayEvent(event: BodyMonitorServerEvent) {
    switch (event.type) {
      case 'bodymonitor_output':
        handleOutput(event)
        break
      case 'bodymonitor_device':
        replayDiscoveredDevices.value = [...replayDiscoveredDevices.value, event.device]
        break
      case 'bodymonitor_devices':
        replayDiscoveredDevices.value = [...event.devices]
        break
      case 'bodymonitor_error':
        replayError.value = event.message
        break
    }
  }

  function getSelectedDeviceLabel(capability: string): string | null {
    return replaySelectedDevices.value.find((device) => device.capability === capability)?.label ?? null
  }

  function getDeviceConnectionState(deviceIdentifier: string | null): DeviceConnectionState | null {
    if (deviceIdentifier === null) {
      return null
    }

    for (const key of getReplayDeviceStateKeys(deviceIdentifier)) {
      const state = replayDeviceConnectionStates.value[key]
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
    replaySessionId,
    replaySessionName,
    replayKind,
    replayStatus,
    replaySpeed,
    replayCursorTimestampMs,
    replayRawLines,
    replaySelectedDevices,
    replayDiscoveredDevices,
    replayDeviceConnectionStates,
    replayError,
    replayChartData,
    replayChartLoading,
    replayChartError,
    clearReplayState,
    clearRawLines,
    startReplay,
    stopReplay,
    setReplaySpeed,
    handleReplayStarted,
    handleReplayProgress,
    handleReplayStopped,
    handleReplayFinished,
    handleReplayEvent,
    getSelectedDeviceLabel,
    getDeviceConnectionState,
    isDeviceOffline,
  }
})

