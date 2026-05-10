import { ref, type Ref } from 'vue'
import type { BrowserMessage, ServerEvent } from '@protocol'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'
export type WsEventHandler = (event: ServerEvent) => boolean | void

const MAX_RECONNECT_MS = 10_000
const BASE_RECONNECT_MS = 1_000

const connectionState: Ref<ConnectionState> = ref('disconnected')
const eventHandlers = new Set<WsEventHandler>()
let socket: WebSocket | null = null
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function getWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws/ui`
}

function dispatch(event: ServerEvent): void {
  for (const handler of eventHandlers) {
    if (handler(event) === true) {
      return
    }
  }
}

function registerHandler(handler: WsEventHandler): () => void {
  eventHandlers.add(handler)

  return () => {
    eventHandlers.delete(handler)
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
  registerHandler,
  send,
  init
} as const

