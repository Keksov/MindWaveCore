<template>
  <div :class="['raw-output', { 'raw-output--fill': fillHeight }]">
    <div class="row items-center q-mb-sm">
      <div class="text-subtitle1">{{ $t('deviceControl.rawOutputTitle') }}</div>
      <q-space />
      <q-btn
        flat
        dense
        size="sm"
        :label="$t('deviceControl.clearButton')"
        @click="clearOutput()"
      />
    </div>
    <q-scroll-area
      ref="scrollArea"
      :style="fillHeight ? undefined : 'height: 340px'"
      :class="['bg-grey-10 rounded-borders', 'raw-output__scroll', { 'raw-output__scroll--fill': fillHeight }]"
    >
      <pre v-if="activeLines.length > 0" class="raw-pre q-pa-sm q-ma-none">{{ activeLines.join('\n') }}</pre>
      <div v-else class="text-grey q-pa-sm">{{ $t('deviceControl.noOutput') }}</div>
    </q-scroll-area>
  </div>
</template>

<script setup lang="ts">
import { computed, watch, ref, nextTick } from 'vue'
import { useSessionStore } from 'stores/session'
import { useReplayStore } from 'stores/replay'
import { QScrollArea } from 'quasar'

withDefaults(defineProps<{
  readonly fillHeight?: boolean
}>(), {
  fillHeight: false,
})

const session = useSessionStore()
const replay = useReplayStore()
const scrollArea = ref<InstanceType<typeof QScrollArea> | null>(null)

const activeLines = computed(() => replay.isReplayMode ? replay.replayRawLines : session.rawLines)

function clearOutput() {
  if (replay.isReplayMode) {
    replay.clearRawLines()
    return
  }

  session.clearRawLines()
}

watch(() => activeLines.value.length, () => {
  nextTick(() => {
    scrollArea.value?.setScrollPercentage('vertical', 1)
  })
})
</script>

<style scoped>
.raw-output {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.raw-output--fill {
  flex: 1 1 auto;
}

.raw-output__scroll--fill {
  flex: 1 1 auto;
  min-height: 0;
}

.raw-pre {
  font-size: 0.82rem;
  line-height: 1.4;
  color: #c7dbff;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
