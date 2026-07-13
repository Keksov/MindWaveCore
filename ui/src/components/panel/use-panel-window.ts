// panel-window (PW1.1, PW-D3): generic per-panel window state — floating / docked (4 edges) /
// detached (separate OS window, PW3.x) — with per-field localStorage persistence. Extracted from
// the fs-browser store's window model so any panel can reuse it. A panel that already persisted
// its geometry under its own keys passes them via opts.storageKeys (backward compatible, no
// migration); new panels get 'mindwave-panel-<id>-*' keys.
import { reactive, watch } from 'vue'

export type PanelMode = 'floating' | 'left' | 'right' | 'top' | 'bottom' | 'detached'

const ALL_MODES: readonly PanelMode[] = ['floating', 'left', 'right', 'top', 'bottom', 'detached']

export interface PanelRect {
  x: number
  y: number
  w: number
  h: number
}

// Legacy localStorage key overrides (PW-D3): the file-open panel keeps its
// existing 'mindwave-fs-browser-*' keys through these.
export interface PanelStorageKeys {
  readonly mode?: string
  readonly prevMode?: string
  readonly dockSize?: string
  readonly floatRect?: string
  readonly open?: string
}

export interface PanelWindowOptions {
  readonly defaultMode?: PanelMode
  readonly defaultOpen?: boolean
  readonly defaultFloatRect?: PanelRect
  readonly defaultDockSize?: number
  /** Docked-panel size clamp so it never collapses nor eats the whole form. */
  readonly minDockSize?: number
  readonly maxDockSize?: number
  /** Floating-window minimum size enforced by the corner resizer. */
  readonly minFloatW?: number
  readonly minFloatH?: number
  readonly storageKeys?: PanelStorageKeys
}

export interface PanelWindowState {
  readonly panelId: string
  open: boolean
  /** Current mode; 'detached' means the panel lives in a child OS window (PW-D6). */
  mode: PanelMode
  /** Last non-detached mode — where the panel returns when the child window closes (PW-D6). */
  prevMode: PanelMode
  dockSize: number
  floatRect: PanelRect
  readonly minFloatW: number
  readonly minFloatH: number
  setMode: (mode: PanelMode) => void
  setDockSize: (px: number) => void
  setFloatRect: (rect: Partial<PanelRect>) => void
}

const DEFAULT_FLOAT: PanelRect = { x: 140, y: 90, w: 900, h: 600 }
const DEFAULT_DOCK_SIZE = 380

const readString = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
  } catch {
    return fallback
  }
}

const readBool = (key: string, fallback: boolean): boolean => {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : raw === '1' || raw === 'true'
  } catch {
    return fallback
  }
}

const readNumber = (key: string, fallback: number): number => {
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

const readRect = (key: string, fallback: PanelRect): PanelRect => {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) {
      return { ...fallback }
    }
    const parsed = JSON.parse(raw) as Partial<PanelRect>
    return {
      x: typeof parsed.x === 'number' ? parsed.x : fallback.x,
      y: typeof parsed.y === 'number' ? parsed.y : fallback.y,
      w: typeof parsed.w === 'number' ? parsed.w : fallback.w,
      h: typeof parsed.h === 'number' ? parsed.h : fallback.h,
    }
  } catch {
    return { ...fallback }
  }
}

const persist = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Ignore quota / privacy-mode failures — persistence is best-effort.
  }
}

// One shared state per panelId within a window: the panel chrome, its host page and the store
// behind it must all see the same geometry. (The detached child window is a separate app
// instance with its own cache — it shares only the persisted localStorage, by design PW-D5.)
const instances = new Map<string, PanelWindowState>()

export function usePanelWindowState(panelId: string, opts: PanelWindowOptions = {}): PanelWindowState {
  const existing = instances.get(panelId)
  if (existing !== undefined) {
    return existing
  }

  const prefix = `mindwave-panel-${panelId}-`
  const keys = {
    mode: opts.storageKeys?.mode ?? `${prefix}mode`,
    prevMode: opts.storageKeys?.prevMode ?? `${prefix}prev-mode`,
    dockSize: opts.storageKeys?.dockSize ?? `${prefix}dock-size`,
    floatRect: opts.storageKeys?.floatRect ?? `${prefix}float`,
    open: opts.storageKeys?.open ?? `${prefix}open`,
  }

  const defaultMode = opts.defaultMode ?? 'floating'
  const defaultFloat = opts.defaultFloatRect ?? DEFAULT_FLOAT
  const minDock = opts.minDockSize ?? 240
  const maxDock = opts.maxDockSize ?? 900

  const mode = readString<PanelMode>(keys.mode, ALL_MODES, defaultMode)
  const state: PanelWindowState = reactive({
    panelId,
    open: readBool(keys.open, opts.defaultOpen ?? false),
    mode,
    // A persisted 'detached' mode must never leave prevMode detached too (PW-D6 fallback path).
    prevMode: readString<PanelMode>(keys.prevMode, ALL_MODES, mode !== 'detached' ? mode : 'floating'),
    dockSize: readNumber(keys.dockSize, opts.defaultDockSize ?? DEFAULT_DOCK_SIZE),
    floatRect: readRect(keys.floatRect, defaultFloat),
    minFloatW: opts.minFloatW ?? 460,
    minFloatH: opts.minFloatH ?? 320,
    setMode: (next: PanelMode): void => {
      if (next !== 'detached') {
        state.prevMode = next
      }
      state.mode = next
    },
    setDockSize: (px: number): void => {
      state.dockSize = Math.max(minDock, Math.min(px, maxDock))
    },
    setFloatRect: (rect: Partial<PanelRect>): void => {
      state.floatRect = { ...state.floatRect, ...rect }
    },
  })

  watch(() => state.mode, (v) => persist(keys.mode, v))
  watch(() => state.prevMode, (v) => persist(keys.prevMode, v))
  watch(() => state.dockSize, (v) => persist(keys.dockSize, String(Math.round(v))))
  watch(() => state.floatRect, (v) => persist(keys.floatRect, JSON.stringify(v)), { deep: true })
  watch(() => state.open, (v) => persist(keys.open, v ? '1' : '0'))

  instances.set(panelId, state)
  return state
}
