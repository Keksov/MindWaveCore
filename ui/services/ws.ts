import { ref, type Ref } from 'vue'
import type { BrowserMessage, BodyMonitorServerEvent, ServerEvent } from '@protocol'
import { useAudioStore } from 'stores/audio'
import { useSessionStore } from 'stores/session'
import { useDeviceStore } from 'stores/device'
import { useReplayStore } from 'stores/replay'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

const MAX_RECONNECT_MS = 10_000
const BASE_RECONNECT_MS = 1_000

const connectionState: Ref<ConnectionState> = ref('disconnected')
let socket: WebSocket | null = null
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function getWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws/ui`
}

function isAudioEvent(event: ServerEvent): boolean {
  return event.type.startsWith('audio_')
}

function isBodyMonitorEvent(event: ServerEvent): event is BodyMonitorServerEvent {
  return !event.type.startsWith('audio_')
}

function dispatch(event: ServerEvent): void {
  const audio = useAudioStore()
  const session = useSessionStore()
  const device = useDeviceStore()
  const replay = useReplayStore()

  if (isAudioEvent(event)) {
    switch (event.type) {
      case 'audio_status':
        audio.handleStatus(event)
        return
      case 'audio_progress':
        audio.handleProgress(event)
        return
      case 'audio_error':
        audio.handleError(event)
        return
      case 'audio_exit':
        audio.handleExit(event)
        return
      case 'audio_render_progress':
        audio.handleRenderProgress(event)
        return
      case 'audio_render_done':
        audio.handleRenderDone(event)
        return
      case 'audio_schedule_loaded':
        audio.handleScheduleLoaded(event)
        return
    }
  }

  switch (event.type) {
    case 'replay_started':
      replay.handleReplayStarted(event)
      return
    case 'replay_progress':
      replay.handleReplayProgress(event)
      return
    case 'replay_stopped':
      replay.handleReplayStopped(event)
      return
    case 'replay_finished':
      replay.handleReplayFinished(event)
      return
  }

  if (replay.isReplayMode && isBodyMonitorEvent(event)) {
    replay.handleReplayEvent(event)
    return
  }

  switch (event.type) {
    case 'bodymonitor_status':
      session.handleStatus(event)
      break
    case 'bodymonitor_started':
      session.handleStarted(event)
      break
    case 'bodymonitor_scan_command':
      session.handleScanCommand(event)
      break
    case 'bodymonitor_output':
      session.handleOutput(event)
      break
    case 'bodymonitor_exit':
      session.handleExit(event)
      break
    case 'bodymonitor_error':
      session.handleError(event)
      break
    case 'bodymonitor_device':
      device.handleDevice(event)
      break
    case 'bodymonitor_devices':
      device.handleDevices(event)
      break
    case 'bodymonitor_stdio_ack':
      session.handleStdioAck(event)
      break
    case 'bodymonitor_stdio_ready':
      session.handleStdioReady()
      break
    case 'bodymonitor_server_ready':
      break
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return
  const delay = Math.min(BASE_RECONNECT_MS * Math.pow(2, reconnectAttempt), MAX_RECONNECT_MS)
  reconnectAttempt++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

function connect(): void {
  if (socket !== null) return

  connectionState.value = 'connecting'
  const ws = new WebSocket(getWsUrl())

  ws.addEventListener('open', () => {
    socket = ws
    connectionState.value = 'connected'
    reconnectAttempt = 0
  })

  ws.addEventListener('close', () => {
    socket = null
    connectionState.value = 'disconnected'
    scheduleReconnect()
  })

  ws.addEventListener('error', () => {
    ws.close()
  })

  ws.addEventListener('message', (ev: MessageEvent) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      dispatch(parsed as ServerEvent)
    }
  })
}

function send(msg: BrowserMessage): boolean {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(msg))
  return true
}

function init(): void {
  if (socket !== null || connectionState.value === 'connecting') return
  connect()
}

export const wsService = {
  connectionState,
  send,
  init
} as const

