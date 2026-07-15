<!-- TT1.2 — the ONE tooltip component for the whole project (tooltip-placement plan, TT-D7/D8).
     Owner req. 3 (2026-07-15): every tooltip goes through this component, and so must every future
     one. Never reach for a bare <q-tooltip>, a native title="", or a hand-rolled div that follows
     the mouse — this is the single place the placement rule (TT-D1) is applied.

     Two binding modes, one look and one rule:
       * element mode (default) — wraps QTooltip, anchored ABOVE the element;
       * cursor mode (`:at="{x, y}"`) — follows the pointer, for canvas hit-tests where there is no
         DOM element to anchor to. Selected by PASSING the `at` prop at all, even as null.

     Delivered to every repo by the `@tooltip` alias, like `@panel/PanelWindow.vue` (PW-D8):
         import AppTooltip from '@tooltip/AppTooltip.vue'
-->
<template>
  <!-- Element mode. anchor/self come AFTER v-bind so a caller cannot quietly opt out of the rule:
       if a placement genuinely needs to differ, it changes here, which is the point of one component. -->
  <q-tooltip v-if="!isCursorMode" v-bind="$attrs" anchor="top middle" self="bottom middle">
    <slot />
  </q-tooltip>

  <!-- Cursor mode. Teleported so no lane/panel overflow can clip it (keeps GT3.17's fix), and reusing
       Quasar's own classes so it is identical to element mode by construction rather than by copied
       CSS values: .q-tooltip = fixed positioning + z-index + padding, .q-tooltip--style = the look. -->
  <Teleport v-else to="body">
    <div
      v-if="at"
      ref="boxEl"
      v-bind="$attrs"
      class="q-tooltip q-tooltip--style no-pointer-events"
      :style="boxStyle"
      role="tooltip"
    >
      <slot />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import { placeCursorTooltip } from './tooltip-place'

interface CursorAnchor {
  x: number
  y: number
}

const props = defineProps<{
  /**
   * Cursor hotspot in VIEWPORT coords (clientX/clientY — the box is position:fixed).
   * Passing this prop at all selects cursor mode; pass null to hide the tooltip.
   */
  at?: CursorAnchor | null
}>()

defineOptions({ inheritAttrs: false })

// Mode is decided by whether the prop was passed, not by its value, so `:at="null"` (nothing hovered)
// still means cursor mode rather than silently falling back to an element tooltip with no anchor.
const isCursorMode = computed(() => props.at !== undefined)

const boxEl = ref<HTMLElement | null>(null)
const boxStyle = ref<Record<string, string>>({ left: '0px', top: '0px', visibility: 'hidden' })

// Placing needs the rendered size, so it takes two passes. The first pass stays `visibility: hidden`
// rather than being parked at a guessed position: a guess would flash for one frame at the wrong
// spot — below-right of the pointer, i.e. exactly the bug being fixed.
watch(
  () => props.at,
  async (at) => {
    if (!at) return
    boxStyle.value = { ...boxStyle.value, visibility: 'hidden' }
    await nextTick()

    const el = boxEl.value
    const anchor = props.at
    if (el === null || !anchor) return

    const { left, top } = placeCursorTooltip({
      x: anchor.x,
      y: anchor.y,
      w: el.offsetWidth,
      h: el.offsetHeight,
      bounds: { width: window.innerWidth, height: window.innerHeight },
    })
    boxStyle.value = { left: `${left}px`, top: `${top}px`, visibility: 'visible' }
  },
  { immediate: true, deep: true },
)
</script>
