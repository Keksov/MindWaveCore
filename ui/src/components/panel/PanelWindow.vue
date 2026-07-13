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

      <!-- FB4.3-refine 1: all window modes collapsed under one icon + menu to cut visual noise. -->
      <q-btn flat dense round size="sm" :icon="modeIcon" class="panel-window__dock-menu-btn">
        <q-tooltip>{{ t('panel.dockMenu') }}</q-tooltip>
        <q-menu auto-close>
          <q-list dense style="min-width: 160px">
            <q-item
              v-for="opt in modeOptions"
              :key="opt.mode"
              clickable
              :active="state.mode === opt.mode"
              @click="state.setMode(opt.mode)"
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
import { computed, type CSSProperties } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PanelMode, PanelWindowState } from './use-panel-window'

const props = defineProps<{
  readonly state: PanelWindowState
  readonly title: string
  readonly icon?: string
}>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()

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
// 'detached' joins this menu in PW3.1.
const modeOptions: readonly ModeOption[] = [
  { mode: 'floating', icon: 'picture_in_picture_alt', label: 'panel.dockFloat' },
  { mode: 'left', icon: 'border_left', label: 'panel.dockLeft' },
  { mode: 'right', icon: 'border_right', label: 'panel.dockRight' },
  { mode: 'top', icon: 'border_top', label: 'panel.dockTop' },
  { mode: 'bottom', icon: 'border_bottom', label: 'panel.dockBottom' },
]
const modeIcon = computed<string>(() => modeOptions.find((o) => o.mode === props.state.mode)?.icon ?? 'picture_in_picture_alt')

const close = (): void => {
  props.state.open = false
  emit('close')
}

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
