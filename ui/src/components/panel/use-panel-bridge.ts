// panel-window (PW2.2, PW-D5): the parent<->child bridge for a detached panel window, over
// BroadcastChannel('mw-panel:<id>') — same-origin is guaranteed because the child is the same
// SPA opened via window.open (PW-D1).
//
// Protocol:
//   parent -> 'parent-hello' (on create + replying to child-ready), 'heartbeat' (every 2s),
//             'parent-gone' (pagehide), 'close-panel' (main side closes the panel)
//   child  -> 'child-ready' (on create), 'child-closed' (its own pagehide),
//             'panel-event' {name, payload} (domain events, e.g. file-open's 'open')
//
// Child-depends-on-parent (PW-D2): the child self-closes when (a) 'parent-gone' arrives and no
// fresh hello follows within the grace period — an F5/hot-reload of the main window re-adopts
// the child in time, so it survives; or (b) it was adopted and the heartbeat goes silent (covers
// a crashed main tab where pagehide never fired). A never-adopted child (a tab opened by hand
// for debugging) is left alone. window.close() works because the real child is script-opened.

export type PanelEventPayload = readonly unknown[]

interface BridgeMessage {
  readonly type:
    | 'parent-hello'
    | 'heartbeat'
    | 'parent-gone'
    | 'close-panel'
    | 'child-ready'
    | 'child-closed'
    | 'panel-event'
    | 'panel-state'
    | 'panel-title'
  readonly name?: string
  readonly payload?: PanelEventPayload
  // PW5.7: parent -> child state snapshot for remote-control panels (e.g. «Список треков»), whose
  // child window holds NO state and renders whatever the parent pushes.
  readonly state?: unknown
  // VS2.8: parent -> child window caption. PanelWindow's :title can be DYNAMIC (e.g. «Параметры:
  // <голос>: Спектр» retargets per lane); the manifest titleKey is only the pre-push fallback.
  readonly title?: string
}

const HEARTBEAT_MS = 2000
const SILENCE_MS = 7000
const GONE_GRACE_MS = 5000
const WATCHDOG_MS = 1000

const channelName = (panelId: string): string => `mw-panel:${panelId}`

export interface PanelBridgeParentHandlers {
  readonly onChildReady?: () => void
  readonly onChildClosed?: () => void
  readonly onPanelEvent?: (name: string, payload: PanelEventPayload) => void
}

export interface PanelBridgeParent {
  /** Ask the child window to close (main-side close, PW-D6). */
  readonly requestClose: () => void
  /** PW5.7: push a state snapshot to the child (remote-control panels). */
  readonly sendState: (state: unknown) => void
  /** VS2.8: push the (possibly dynamic) panel title — becomes the child's document.title. */
  readonly sendTitle: (title: string) => void
  readonly dispose: () => void
}

export function createPanelBridgeParent(
  panelId: string,
  handlers: PanelBridgeParentHandlers = {},
): PanelBridgeParent {
  const channel = new BroadcastChannel(channelName(panelId))
  const post = (msg: BridgeMessage): void => channel.postMessage(msg)

  channel.onmessage = (event: MessageEvent<BridgeMessage>): void => {
    const msg = event.data
    if (msg.type === 'child-ready') {
      // Adopt immediately — don't make a freshly opened child wait a heartbeat tick.
      post({ type: 'parent-hello' })
      handlers.onChildReady?.()
    } else if (msg.type === 'child-closed') {
      handlers.onChildClosed?.()
    } else if (msg.type === 'panel-event' && msg.name !== undefined) {
      handlers.onPanelEvent?.(msg.name, msg.payload ?? [])
    }
  }

  // Covers the reload case: a child orphaned by 'parent-gone' is re-adopted by this hello.
  post({ type: 'parent-hello' })
  const heartbeat = window.setInterval(() => post({ type: 'heartbeat' }), HEARTBEAT_MS)
  const onPageHide = (): void => post({ type: 'parent-gone' })
  window.addEventListener('pagehide', onPageHide)

  return {
    requestClose: (): void => post({ type: 'close-panel' }),
    sendState: (state: unknown): void => post({ type: 'panel-state', state }),
    sendTitle: (title: string): void => post({ type: 'panel-title', title }),
    dispose: (): void => {
      window.clearInterval(heartbeat)
      window.removeEventListener('pagehide', onPageHide)
      channel.close()
    },
  }
}

export interface PanelBridgeChild {
  /** Forward a content-component event (e.g. 'open') to the main window. */
  readonly sendEvent: (name: string, payload: PanelEventPayload) => void
  readonly dispose: () => void
}

export interface PanelBridgeChildHandlers {
  /** PW5.7: a state snapshot pushed by the parent (remote-control panels). */
  readonly onState?: (state: unknown) => void
  /** VS2.8: a window caption pushed by the parent (dynamic panel titles). */
  readonly onTitle?: (title: string) => void
}

export function createPanelBridgeChild(panelId: string, handlers: PanelBridgeChildHandlers = {}): PanelBridgeChild {
  const channel = new BroadcastChannel(channelName(panelId))
  const post = (msg: BridgeMessage): void => channel.postMessage(msg)

  let adopted = false
  let lastSeen = 0
  let goneDeadline: number | null = null

  channel.onmessage = (event: MessageEvent<BridgeMessage>): void => {
    const msg = event.data
    if (msg.type === 'parent-hello' || msg.type === 'heartbeat') {
      adopted = true
      lastSeen = Date.now()
      goneDeadline = null
    } else if (msg.type === 'parent-gone') {
      goneDeadline = Date.now() + GONE_GRACE_MS
    } else if (msg.type === 'close-panel') {
      window.close()
    } else if (msg.type === 'panel-state') {
      handlers.onState?.(msg.state)
    } else if (msg.type === 'panel-title' && msg.title !== undefined) {
      handlers.onTitle?.(msg.title)
    }
  }

  const watchdog = window.setInterval(() => {
    const now = Date.now()
    if (goneDeadline !== null && now >= goneDeadline) {
      window.close()
      return
    }
    if (adopted && now - lastSeen > SILENCE_MS) {
      window.close()
    }
  }, WATCHDOG_MS)

  const onPageHide = (): void => post({ type: 'child-closed' })
  window.addEventListener('pagehide', onPageHide)

  post({ type: 'child-ready' })

  return {
    sendEvent: (name: string, payload: PanelEventPayload): void =>
      post({ type: 'panel-event', name, payload }),
    dispose: (): void => {
      window.clearInterval(watchdog)
      window.removeEventListener('pagehide', onPageHide)
      channel.close()
    },
  }
}
