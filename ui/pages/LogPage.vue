<template>
  <q-page padding class="log-page column no-wrap">
    <q-banner v-if="replay.isReplayMode" class="bg-amber-5 text-dark rounded-borders q-mb-md">
      <div class="row items-center justify-between q-gutter-sm">
        <div>
          <div class="text-subtitle2">{{ $t('archive.replayBadge') }}</div>
          <div class="text-caption">{{ $t('archive.replayActiveBanner', { name: replay.replaySessionName }) }}</div>
        </div>
        <q-btn flat dense icon="close" :label="$t('archive.stopReplay')" @click="replay.stopReplay()" />
      </div>
    </q-banner>
    <raw-output fill-height />
  </q-page>
</template>

<script setup lang="ts">
import RawOutput from '../components/RawOutput.vue'
import { useReplayStore } from 'stores/replay'

const replay = useReplayStore()
</script>

<style scoped>
.log-page {
  min-height: 0;
}
</style>