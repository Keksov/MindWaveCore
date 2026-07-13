<template>
  <!-- panel-window (PW2.1, PW-D4): the detached child window's whole page — resolves the panel
       content component from the module-contributed registry by the /panel/:panelId route param
       and renders it full-window. The same content component is hosted by PanelWindow in the
       main window; here the OS window frame is the chrome. -->
  <div class="panel-host">
    <component
      :is="panelComponent"
      v-if="panelComponent !== null"
      v-bind="eventHandlers"
    />
    <div v-else class="panel-host__missing">
      <q-banner dense rounded class="bg-orange-1 text-orange-10">
        {{ t('panel.unknown') }}: {{ panelId }}
      </q-banner>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, watchEffect, type Component } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { createPanelBridgeChild, type PanelBridgeChild } from '@panel/use-panel-bridge'
import { detachedRectKey, writePanelScreenRect } from '@panel/use-panel-window'
import { modulePanels } from '../src/modules'

const route = useRoute()
const { t } = useI18n()

const panelId = computed<string>(() => String(route.params.panelId ?? ''))
const panel = computed(() => modulePanels.find((p) => p.id === panelId.value))

// PW2.2 (PW-D5): the child side of the panel bridge — announces child-ready, keeps the
// parent-liveness watchdog (self-close on parent loss, PW-D2), obeys close-panel, and carries
// the content component's events to the main window. One bridge per window: the panel id is
// fixed by this window's URL.
let bridge: PanelBridgeChild | null = panel.value !== undefined ? createPanelBridgeChild(panelId.value) : null

// PW4.1 (PW-D7): remember this window's on-screen rect so the next detach/auto-reopen restores
// it. There is no move event, so poll screenX/screenY on an interval as well as on resize; write
// only when it actually changed. Content coordinates (screenX/screenY + innerWidth/innerHeight).
let geometryTimer: number | null = null
let lastGeometry = ''

const captureGeometry = (): void => {
  if (panelId.value === '') {
    return
  }
  const w = window.innerWidth
  const h = window.innerHeight
  if (w <= 0 || h <= 0) {
    return
  }
  const rect = { x: window.screenX, y: window.screenY, w, h }
  const signature = `${rect.x},${rect.y},${rect.w},${rect.h}`
  if (signature === lastGeometry) {
    return
  }
  lastGeometry = signature
  writePanelScreenRect(detachedRectKey(panelId.value), rect)
}

onMounted(() => {
  window.addEventListener('resize', captureGeometry)
  geometryTimer = window.setInterval(captureGeometry, 1000)
  captureGeometry()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', captureGeometry)
  if (geometryTimer !== null) {
    window.clearInterval(geometryTimer)
    geometryTimer = null
  }
  bridge?.dispose()
  bridge = null
})

const panelComponent = computed<Component | null>(() => {
  const p = panel.value
  return p === undefined ? null : defineAsyncComponent(p.component)
})

// The OS window caption (PW-D4); tracks the locale too.
watchEffect(() => {
  const p = panel.value
  document.title = p === undefined ? t('app.title') : t(p.titleKey)
})

// Generic listeners for the content component: 'close' closes this OS window (allowed for
// script-opened windows; the pagehide handler tells the parent); the panel's declared events
// are forwarded over the bridge to the main window (PW2.2).
const eventHandlers = computed<Record<string, (...args: unknown[]) => void>>(() => {
  const p = panel.value
  if (p === undefined) {
    return {}
  }
  const handlers: Record<string, (...args: unknown[]) => void> = {
    onClose: (): void => window.close(),
  }
  for (const name of p.events ?? []) {
    handlers[`on${name.charAt(0).toUpperCase()}${name.slice(1)}`] = (...args: unknown[]): void => {
      bridge?.sendEvent(name, args)
    }
  }
  return handlers
})
</script>

<style scoped lang="scss">
.panel-host {
  height: 100vh;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--q-dark-page, #fff);

  &__missing { padding: 12px; }
}
</style>
