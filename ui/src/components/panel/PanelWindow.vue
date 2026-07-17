<template>
  <!-- panel-window (PW1.1, PW-D3): the universal panel chrome — floating (draggable) or
       edge-docked — extracted from FileOpenDialog (FB4.2/FB4.3). The host page teleports it to
       <body> when floating and hosts it as a flex child when docked; content comes in via slots.
       In detached mode (PW3.x) the panel lives in a child OS window, so nothing renders here. -->
  <div
    v-if="state.open && state.mode !== 'detached'"
    class="panel-window"
    :class="modeClass"
    :style="rootStyle"
    tabindex="0"
  >
    <div class="panel-window__titlebar row items-center no-wrap">
      <div
        class="panel-window__drag row items-center no-wrap col"
        :class="{ 'panel-window__drag--active': isFloating }"
        @pointerdown="onTitlePointerDown"
      >
        <q-icon v-if="icon !== undefined" :name="icon" size="18px" class="q-mr-sm" />
        <span class="panel-window__title">{{ title }}</span>
      </div>

      <!-- SS2.3: optional consumer-supplied title-bar action buttons, left of the dock menu. Unused
           by file-open / track-list (an empty named slot renders nothing) — «Параметры» puts its
           presets button here. -->
      <slot name="titlebar-actions" />

      <!-- FB4.3-refine 1: all window modes collapsed under one icon + menu to cut visual noise. -->
      <q-btn flat dense round size="sm" :icon="modeIcon" class="panel-window__dock-menu-btn">
        <app-tooltip>{{ t('panel.dockMenu') }}</app-tooltip>
        <q-menu auto-close>
          <q-list dense style="min-width: 160px">
            <q-item
              v-for="opt in modeOptions"
              :key="opt.mode"
              clickable
              :active="state.mode === opt.mode"
              @click="onModeSelect(opt.mode)"
            >
              <q-item-section avatar><q-icon :name="opt.icon" /></q-item-section>
              <q-item-section>{{ t(opt.label) }}</q-item-section>
            </q-item>
          </q-list>
        </q-menu>
      </q-btn>
      <q-btn flat dense round size="sm" icon="close" :aria-label="t('panel.close')" @click="close" />
    </div>

    <q-separator />

    <slot />
    <slot name="footer" />

    <!-- Resizers: a corner grip when floating, an edge grip when docked. -->
    <div v-if="isFloating" class="panel-window__float-resizer" @pointerdown="onFloatResizePointerDown" />
    <div
      v-else
      class="panel-window__dock-resizer"
      :class="`panel-window__dock-resizer--${state.mode}`"
      @pointerdown="onDockResizePointerDown"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch, type CSSProperties } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuasar } from 'quasar'
import { detachedRectKey, readPanelScreenRect, type PanelMode, type PanelWindowState } from './use-panel-window'
import { createPanelBridgeParent, type PanelBridgeParent, type PanelEventPayload } from './use-panel-bridge'
import AppTooltip from '@tooltip/AppTooltip.vue'

const props = withDefaults(defineProps<{
  readonly state: PanelWindowState
  readonly title: string
  readonly icon?: string
  // PW5.6c: a panel that can't sensibly run in a separate OS window opts out with allow-detach=false
  // to hide the "Separate window" mode. PW5.7c-fix: this MUST default to true — a type-only Boolean
  // prop that is ABSENT is cast by Vue to `false` (not `undefined`), so without the default below
  // modeOptions would drop «detached» for EVERY panel that doesn't explicitly pass :allow-detach.
  // That silent cast is exactly what hid the mode for both file-open and «Список треков».
  readonly allowDetach?: boolean
  // PW5.7: remote-control panels push a serializable state snapshot to their detached child window
  // (which holds no state of its own). Ignored while in-window / for panels that don't set it.
  readonly bridgeState?: unknown
}>(), {
  allowDetach: true,
})

const emit = defineEmits<{
  close: []
  // PW3.1 (PW-D5): a content event bridged back from the detached child window.
  panelEvent: [name: string, payload: PanelEventPayload]
}>()

const { t } = useI18n()
const $q = useQuasar()

const isFloating = computed<boolean>(() => props.state.mode === 'floating')
const modeClass = computed<string>(() =>
  isFloating.value ? 'panel-window--floating' : `panel-window--dock-${props.state.mode}`,
)
const rootStyle = computed<CSSProperties>(() => {
  if (isFloating.value) {
    const r = props.state.floatRect
    return { position: 'fixed', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, zIndex: 3000 }
  }
  if (props.state.mode === 'left' || props.state.mode === 'right') {
    return { width: `${props.state.dockSize}px` }
  }
  return { height: `${props.state.dockSize}px` }
})

interface ModeOption {
  readonly mode: PanelMode
  readonly icon: string
  readonly label: string
}
const ALL_MODE_OPTIONS: readonly ModeOption[] = [
  { mode: 'floating', icon: 'picture_in_picture_alt', label: 'panel.dockFloat' },
  { mode: 'left', icon: 'border_left', label: 'panel.dockLeft' },
  { mode: 'right', icon: 'border_right', label: 'panel.dockRight' },
  { mode: 'top', icon: 'border_top', label: 'panel.dockTop' },
  { mode: 'bottom', icon: 'border_bottom', label: 'panel.dockBottom' },
  { mode: 'detached', icon: 'open_in_new', label: 'panel.detach' },
]
const modeOptions = computed<readonly ModeOption[]>(() =>
  props.allowDetach === false ? ALL_MODE_OPTIONS.filter((o) => o.mode !== 'detached') : ALL_MODE_OPTIONS,
)
const modeIcon = computed<string>(() => ALL_MODE_OPTIONS.find((o) => o.mode === props.state.mode)?.icon ?? 'picture_in_picture_alt')

const close = (): void => {
  props.state.open = false
  emit('close')
}

// ---- Detached mode (PW3.1, PW-D1/PW-D6) --------------------------------------------------------
// The panel content moves to a child OS window: same SPA at #/panel/<id> via window.open — in
// AppCore that's WebView2's default popup (same process/origin), in a browser a normal popup.
// While detached this component stays mounted (the host keeps it while the panel is open) but
// renders nothing; it owns the parent side of the bridge.

let bridge: PanelBridgeParent | null = null
// A child F5 looks like child-closed followed by child-ready — debounce the "restore to the
// previous in-window mode" reaction so a reload doesn't yank the panel back (PW-D6).
let childClosedTimer: number | null = null

const cancelChildClosedTimer = (): void => {
  if (childClosedTimer !== null) {
    window.clearTimeout(childClosedTimer)
    childClosedTimer = null
  }
}

const inWindowMode = (): PanelMode =>
  props.state.prevMode !== 'detached' ? props.state.prevMode : 'floating'

const openChildWindow = (): boolean => {
  // Reopen at the child's last on-screen rect (PW4.1); first-ever detach falls back to the
  // floating size. The named target means a still-open child is reused/focused, never duplicated.
  const saved = readPanelScreenRect(detachedRectKey(props.state.panelId))
  const r = props.state.floatRect
  const features = [`width=${Math.round(saved?.w ?? r.w)}`, `height=${Math.round(saved?.h ?? r.h)}`]
  if (saved !== null) {
    features.push(`left=${Math.round(saved.x)}`, `top=${Math.round(saved.y)}`)
  }
  const win = window.open(
    `#/panel/${props.state.panelId}`,
    `mw-panel-${props.state.panelId}`,
    features.join(','),
  )
  if (win === null) {
    return false
  }
  win.focus()
  return true
}

const teardownBridge = (): void => {
  cancelChildClosedTimer()
  bridge?.dispose()
  bridge = null
}

// PW5.7: push the current snapshot to the detached child (no-op while in-window — bridge is null).
const sendCurrentState = (): void => {
  if (bridge !== null && props.bridgeState !== undefined) {
    bridge.sendState(props.bridgeState)
  }
}

// VS2.8: the title prop can be dynamic (e.g. it names the lane a settings panel is retargeted to)
// — mirror it to the detached child's window caption.
const sendCurrentTitle = (): void => {
  if (bridge !== null) {
    bridge.sendTitle(props.title)
  }
}

const ensureBridge = (): void => {
  if (bridge !== null) {
    return
  }
  bridge = createPanelBridgeParent(props.state.panelId, {
    onChildReady: (): void => {
      cancelChildClosedTimer()
      // A freshly-ready child gets the current snapshot immediately (PW5.7) + the caption (VS2.8).
      sendCurrentState()
      sendCurrentTitle()
    },
    onChildClosed: (): void => {
      cancelChildClosedTimer()
      childClosedTimer = window.setTimeout(() => {
        childClosedTimer = null
        // The user closed the child window — the panel returns to the main window (stays open).
        if (props.state.mode === 'detached' && props.state.open) {
          teardownBridge()
          props.state.setMode(inWindowMode())
        }
      }, 1000)
    },
    onPanelEvent: (name, payload): void => emit('panelEvent', name, payload),
  })
}

const detachBlocked = (): void => {
  $q.notify({ type: 'warning', message: t('panel.detachBlocked') })
}

const onModeSelect = (mode: PanelMode): void => {
  if (mode !== 'detached') {
    props.state.setMode(mode)
    return
  }
  // Open the child first (still inside the click's user activation); only then flip the mode —
  // a blocked popup (PW-D1 fallback) leaves the panel exactly where it was.
  if (!openChildWindow()) {
    detachBlocked()
    return
  }
  ensureBridge()
  props.state.setMode('detached')
}

// App start / returning to the hosting page with a persisted detached panel: one auto-reopen
// attempt (PW-D6); without user activation a browser blocker may refuse -> fall back in-window.
onMounted(() => {
  if (props.state.open && props.state.mode === 'detached') {
    if (openChildWindow()) {
      ensureBridge()
    } else {
      props.state.setMode(inWindowMode())
      detachBlocked()
    }
  }
})

// Main-side close while detached (PW-D6): closing the panel closes the child window too.
watch(() => props.state.open, (open) => {
  if (!open && bridge !== null) {
    bridge.requestClose()
    teardownBridge()
  }
})

// PW5.7: forward snapshot changes to the detached child (deep — the snapshot is an object).
watch(() => props.bridgeState, () => sendCurrentState(), { deep: true })
// VS2.8: forward title changes too (retargeting a panel renames its detached window).
watch(() => props.title, () => sendCurrentTitle())

// Host unmount (e.g. the main window navigates away): close the child cleanly instead of letting
// its watchdog time out. mode stays 'detached' + open stays true, so remounting reopens it.
onBeforeUnmount(() => {
  if (bridge !== null && props.state.open && props.state.mode === 'detached') {
    bridge.requestClose()
  }
  teardownBridge()
})

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max))

// Generic pointer-drag: wire window listeners until pointerup.
const beginDrag = (onMove: (event: PointerEvent) => void): void => {
  const move = (event: PointerEvent): void => onMove(event)
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// FB4.2: drag the floating window by its title bar.
const onTitlePointerDown = (event: PointerEvent): void => {
  if (!isFloating.value) {
    return
  }
  event.preventDefault()
  const startX = event.clientX
  const startY = event.clientY
  const origin = { ...props.state.floatRect }
  beginDrag((moveEvent) => {
    props.state.setFloatRect({
      x: clamp(origin.x + (moveEvent.clientX - startX), 0, window.innerWidth - 80),
      y: clamp(origin.y + (moveEvent.clientY - startY), 0, window.innerHeight - 40),
    })
  })
}

// FB4.2: resize the floating window from its bottom-right grip.
const onFloatResizePointerDown = (event: PointerEvent): void => {
  event.preventDefault()
  event.stopPropagation()
  const startX = event.clientX
  const startY = event.clientY
  const origin = { ...props.state.floatRect }
  beginDrag((moveEvent) => {
    props.state.setFloatRect({
      w: Math.max(props.state.minFloatW, origin.w + (moveEvent.clientX - startX)),
      h: Math.max(props.state.minFloatH, origin.h + (moveEvent.clientY - startY)),
    })
  })
}

// FB4.3: resize a docked panel by dragging its inner edge. The delta sign depends on the dock side.
const onDockResizePointerDown = (event: PointerEvent): void => {
  event.preventDefault()
  event.stopPropagation()
  const mode = props.state.mode
  const startX = event.clientX
  const startY = event.clientY
  const startSize = props.state.dockSize
  beginDrag((moveEvent) => {
    let delta = 0
    if (mode === 'left') delta = moveEvent.clientX - startX
    else if (mode === 'right') delta = startX - moveEvent.clientX
    else if (mode === 'top') delta = moveEvent.clientY - startY
    else if (mode === 'bottom') delta = startY - moveEvent.clientY
    props.state.setDockSize(startSize + delta)
  })
}
</script>

<style scoped lang="scss">
.panel-window {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--q-dark-page, #fff);
  box-sizing: border-box;

  &--floating {
    border: 1px solid rgba(128, 128, 128, 0.35);
    border-radius: 6px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }

  &--dock-left,
  &--dock-right,
  &--dock-top,
  &--dock-bottom {
    height: 100%;
    position: relative;
  }
  &--dock-left { order: 0; flex: 0 0 auto; border-right: 1px solid rgba(128, 128, 128, 0.35); }
  &--dock-right { order: 2; flex: 0 0 auto; border-left: 1px solid rgba(128, 128, 128, 0.35); }
  &--dock-top { order: 0; flex: 0 0 auto; width: 100%; border-bottom: 1px solid rgba(128, 128, 128, 0.35); }
  &--dock-bottom { order: 2; flex: 0 0 auto; width: 100%; border-top: 1px solid rgba(128, 128, 128, 0.35); }

  &__titlebar {
    flex: 0 0 auto;
    padding: 2px 4px 2px 8px;
    background: rgba(128, 128, 128, 0.1);
    user-select: none;
  }

  &__drag {
    min-width: 0;
    padding: 4px 0;
    &--active { cursor: move; }
  }

  &__title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__float-resizer {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
  }

  &__dock-resizer {
    position: absolute;
    z-index: 5;
    &--left { top: 0; bottom: 0; right: 0; width: 6px; cursor: col-resize; }
    &--right { top: 0; bottom: 0; left: 0; width: 6px; cursor: col-resize; }
    &--top { left: 0; right: 0; bottom: 0; height: 6px; cursor: row-resize; }
    &--bottom { left: 0; right: 0; top: 0; height: 6px; cursor: row-resize; }
  }
}
</style>
