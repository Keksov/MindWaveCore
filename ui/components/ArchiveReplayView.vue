<template>
  <div class="archive-replay-view">
    <q-card flat bordered class="archive-replay-view__card column no-wrap">
      <q-card-section class="row items-center justify-between q-col-gutter-md archive-replay-view__header-row">
        <div class="col min-w-0">
          <div class="text-subtitle1 ellipsis" :title="sessionTitle">
            {{ sessionTitle }}
          </div>
          <div class="text-caption text-grey-5">
            {{ statusText }}
          </div>
        </div>

        <div class="col archive-replay-view__header-devices">
          <div v-if="selectedDevices.length > 0" class="archive-replay-view__header-devices-content row items-center q-gutter-sm">
            <span class="text-caption text-grey-5 archive-replay-view__header-devices-label">
              {{ $t('archive.devices') }}
            </span>

            <div class="archive-replay-view__device-list archive-replay-view__device-list--header">
              <q-chip
                v-for="device in selectedDevices"
                :key="`${device.capability}:${device.label}`"
                dense
                color="grey-9"
                text-color="grey-2"
              >
                {{ capabilityLabel(device.capability) }}: {{ device.label }}
              </q-chip>
            </div>
          </div>
        </div>

        <div class="col-auto row items-center q-gutter-sm">
          <q-btn-group v-if="hasEegData" flat class="archive-replay-view__mode-group">
            <q-btn
              v-for="opt in eegModeOptions"
              :key="opt.value"
              dense
              flat
              :icon="opt.icon"
              :color="replayEegMode === opt.value ? 'secondary' : undefined"
              @click="replayEegMode = opt.value"
            >
              <q-tooltip>{{ opt.tooltip }}</q-tooltip>
            </q-btn>
          </q-btn-group>

          <q-chip dense color="blue-grey-8" text-color="blue-grey-1">
            {{ statusChipLabel }}
          </q-chip>
          <q-btn flat dense icon="close" :label="$t('common.closeAction')" @click="emitClose" />
        </div>
      </q-card-section>

      <q-separator />

      <q-card-section class="archive-replay-view__split-section q-pa-none">
        <div v-if="hasSchedule" class="archive-replay-view__splitter-container" ref="splitterContainerEl">
          <q-splitter
            horizontal
            class="archive-replay-view__splitter"
            v-model="replaySplitPx"
            unit="px"
            :limits="splitterLimits"
          >
            <template #before>
              <div class="archive-replay-view__pane archive-replay-view__pane--chart q-pa-md">
                <div class="archive-replay-view__chart-section">
                  <template v-if="hasChartData && chartData !== null">
                    <template v-if="isStandaloneEegMode && hasEegData">
                      <eeg-current-readings-chart
                        v-if="replayEegMode === 'bands'"
                        class="archive-replay-view__chart"
                        :data="chartData"
                        :anchor-timestamp-ms="displayedReplayTimestampMs"
                        show-signal-badge
                      />

                      <eeg-radar-chart
                        v-else
                        class="archive-replay-view__chart"
                        :data="chartData"
                        :anchor-timestamp-ms="displayedReplayTimestampMs"
                      />
                    </template>

                    <device-data-chart
                      v-else
                      class="archive-replay-view__chart"
                      :data="chartData"
                      mode="loaded"
                      :eeg-mode="replayEegMode"
                      viewport-preset="fit"
                    />
                  </template>

                  <div v-else-if="isChartLoading" class="archive-replay-view__placeholder column items-center justify-center text-grey-5">
                    <q-spinner-hourglass size="lg" color="secondary" />
                    <div class="q-mt-sm">{{ $t('monitoring.chartLoading') }}</div>
                  </div>

                  <div v-else class="archive-replay-view__placeholder column items-center justify-center text-grey-5">
                    <div class="text-subtitle2">{{ $t('monitoring.chartEmptyTitle') }}</div>
                    <div class="text-caption q-mt-xs text-center">
                      {{ $t('archive.replayNoChart') }}
                    </div>
                  </div>

                  <div v-if="chartError !== null" class="text-negative q-mt-md">
                    {{ chartError }}
                  </div>
                </div>

                <div class="archive-replay-view__timeline row q-col-gutter-sm q-row-gutter-xs q-mt-sm">
                  <div class="col-auto">
                    <q-btn
                      dense
                      round
                      color="primary"
                      :icon="isPlaying ? 'stop' : 'play_arrow'"
                      :disable="!canUseControls"
                      :title="playControlTitle ?? undefined"
                      @click="handlePlayStop"
                    />
                  </div>

                  <div class="col archive-replay-view__timeline-track" :style="timelineTrackStyle">
                    <q-slider
                      v-model="sessionSliderMs"
                      class="archive-replay-view__slider"
                      label-always
                      :label-value="sessionSliderProgressLabel"
                      :min="replayTimeSliderMinTimestampMs"
                      :max="replayTimeSliderMaxTimestampMs"
                      :step="1000"
                      :disable="!canSeekReplay"
                      color="secondary"
                      @update:model-value="handleSessionSliderInput"
                      @change="handleSessionSeek"
                    />

                    <div class="archive-replay-view__timeline-end-labels text-caption text-grey-5">
                      <div class="row items-center q-gutter-xs">
                        <span>{{ $t('monitoring.replaySpeed') }}</span>
                        <q-btn-group flat>
                          <q-btn
                            v-for="speed in replaySpeedOptions"
                            :key="speed"
                            dense
                            flat
                            no-caps
                            :disable="!canUseControls"
                            :color="session?.speed === speed ? 'secondary' : undefined"
                            :label="`${speed}x`"
                            @click="setReplaySpeed(speed)"
                          />
                        </q-btn-group>
                      </div>
                      <span v-if="sessionError !== null" class="text-negative">{{ sessionError }}</span>
                      <span v-else-if="playControlHint !== null" class="text-warning">{{ playControlHint }}</span>
                      <div class="row q-gutter-xs">
                        <span>{{ sessionSliderElapsedLabel }}</span>
                        <span>{{ sessionSliderDurationLabel }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </template>

            <template #after>
              <div class="archive-replay-view__pane archive-replay-view__pane--schedule q-pa-md">
                <div ref="scheduleSectionEl" class="archive-replay-view__schedule-section">
                  <gnaural-schedule-view
                    class="archive-replay-view__schedule"
                    :schedule="currentSchedule!"
                    :file-path="null"
                    :position-sec="schedulePositionSec"
                    :transport-state="scheduleTransportState"
                    :track-state-busy="true"
                    :can-seek="scheduleCanSeek"
                    :ui-state-scope="scheduleScope"
                    @seek="handleScheduleSeek"
                  />
                </div>
              </div>
            </template>
          </q-splitter>
        </div>

        <div v-else class="archive-replay-view__pane archive-replay-view__pane--chart q-pa-md">
          <div class="archive-replay-view__chart-section">
            <template v-if="hasChartData && chartData !== null">
              <template v-if="isStandaloneEegMode && hasEegData">
                <eeg-current-readings-chart
                  v-if="replayEegMode === 'bands'"
                  class="archive-replay-view__chart"
                  :data="chartData"
                  :anchor-timestamp-ms="displayedReplayTimestampMs"
                  show-signal-badge
                />

                <eeg-radar-chart
                  v-else
                  class="archive-replay-view__chart"
                  :data="chartData"
                  :anchor-timestamp-ms="displayedReplayTimestampMs"
                />
              </template>

              <device-data-chart
                v-else
                class="archive-replay-view__chart"
                :data="chartData"
                mode="loaded"
                :eeg-mode="replayEegMode"
                viewport-preset="fit"
              />
            </template>

            <div v-else-if="isChartLoading" class="archive-replay-view__placeholder column items-center justify-center text-grey-5">
              <q-spinner-hourglass size="lg" color="secondary" />
              <div class="q-mt-sm">{{ $t('monitoring.chartLoading') }}</div>
            </div>

            <div v-else class="archive-replay-view__placeholder column items-center justify-center text-grey-5">
              <div class="text-subtitle2">{{ $t('monitoring.chartEmptyTitle') }}</div>
              <div class="text-caption q-mt-xs text-center">
                {{ $t('archive.replayNoChart') }}
              </div>
            </div>

            <div v-if="chartError !== null" class="text-negative q-mt-md">
              {{ chartError }}
            </div>
          </div>

          <div class="archive-replay-view__timeline row q-col-gutter-sm q-row-gutter-xs q-mt-sm">
            <div class="col-auto">
              <q-btn
                dense
                round
                color="primary"
                :icon="isPlaying ? 'stop' : 'play_arrow'"
                :disable="!canUseControls"
                :title="playControlTitle ?? undefined"
                @click="handlePlayStop"
              />
            </div>

            <div class="col archive-replay-view__timeline-track" :style="timelineTrackStyle">
              <q-slider
                v-model="sessionSliderMs"
                class="archive-replay-view__slider"
                label-always
                :label-value="sessionSliderProgressLabel"
                :min="replayTimeSliderMinTimestampMs"
                :max="replayTimeSliderMaxTimestampMs"
                :step="1000"
                :disable="!canSeekReplay"
                color="secondary"
                @update:model-value="handleSessionSliderInput"
                @change="handleSessionSeek"
              />

              <div class="archive-replay-view__timeline-end-labels text-caption text-grey-5">
                <div class="row items-center q-gutter-xs">
                  <span>{{ $t('monitoring.replaySpeed') }}</span>
                  <q-btn-group flat>
                    <q-btn
                      v-for="speed in replaySpeedOptions"
                      :key="speed"
                      dense
                      flat
                      no-caps
                      :disable="!canUseControls"
                      :color="session?.speed === speed ? 'secondary' : undefined"
                      :label="`${speed}x`"
                      @click="setReplaySpeed(speed)"
                    />
                  </q-btn-group>
                </div>
                <span v-if="sessionError !== null" class="text-negative">{{ sessionError }}</span>
                <span v-else-if="playControlHint !== null" class="text-warning">{{ playControlHint }}</span>
                <div class="row q-gutter-xs">
                  <span>{{ sessionSliderElapsedLabel }}</span>
                  <span>{{ sessionSliderDurationLabel }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </q-card-section>
    </q-card>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ReplaySpeed } from '@protocol'
import { hasLogChartData } from '../../../SharedPasCore/ts/log-chart'
import { wsService } from 'src/services/ws'
import { useReplayStore } from 'stores/replay'

const DeviceDataChart = defineAsyncComponent(() => import('../../../BodyMonitorCore/ui/components/DeviceDataChart.vue'))
const EegRadarChart = defineAsyncComponent(() => import('../../../BodyMonitorCore/ui/components/EegRadarChart.vue'))
const EegCurrentReadingsChart = defineAsyncComponent(() => import('../../../BodyMonitorCore/ui/components/EegCurrentReadingsChart.vue'))
const GnauralScheduleView = defineAsyncComponent(() => import('../../../GnauralCore/ui/components/GnauralScheduleView.vue'))

const props = defineProps<{
  readonly sessionId: number
}>()

const emit = defineEmits<{
  close: []
}>()

const replay = useReplayStore()
const { t } = useI18n()

type ReplayEegMode = 'bands' | 'radar'

interface EegModeOption {
  readonly value: ReplayEegMode
  readonly icon: string
  readonly tooltip: string
}

const replaySpeedOptions = [1, 2, 4, 10] as const
const replayEegMode = ref<ReplayEegMode>('radar')

const REPLAY_SPLIT_STORAGE_KEY = 'archive-replay-split-px'
const REPLAY_SPLIT_DEFAULT = 400
const REPLAY_SPLIT_CHART_MIN = 200
const REPLAY_SPLIT_AUDIO_MIN = 320
const GNAURAL_MAIN_PLOT_RIGHT_GUTTER_PX = 44

const storedReplaySplitPx = parseFloat(
  localStorage.getItem(REPLAY_SPLIT_STORAGE_KEY) ?? String(REPLAY_SPLIT_DEFAULT),
)
const replaySplitPx = ref(
  Number.isFinite(storedReplaySplitPx) ? storedReplaySplitPx : REPLAY_SPLIT_DEFAULT,
)
watch(replaySplitPx, (value) => {
  if (!Number.isFinite(value)) {
    replaySplitPx.value = REPLAY_SPLIT_DEFAULT
    return
  }

  localStorage.setItem(REPLAY_SPLIT_STORAGE_KEY, String(value))
})

const splitterContainerEl = ref<HTMLDivElement | null>(null)
const scheduleSectionEl = ref<HTMLElement | null>(null)
const splitterContainerHeight = ref(0)
const timelineRightInsetPx = ref(0)
const timelineTrackStyle = computed(() => {
  if (timelineRightInsetPx.value <= 0) {
    return {}
  }

  return {
    paddingInlineEnd: `${timelineRightInsetPx.value}px`,
  }
})
const splitterLimits = computed<[number, number]>(() => {
  const availableHeight = Math.max(0, splitterContainerHeight.value)

  // Audio pane minimum has priority when available space is limited.
  const maxTop = Math.max(0, availableHeight - REPLAY_SPLIT_AUDIO_MIN)
  const minTop = Math.min(REPLAY_SPLIT_CHART_MIN, maxTop)
  return [minTop, maxTop]
})

// Re-clamp position on container resize so the audio pane never goes off-screen.
watch(splitterLimits, ([min, max]) => {
  if (replaySplitPx.value < min) {
    replaySplitPx.value = min
  } else if (replaySplitPx.value > max) {
    replaySplitPx.value = max
  }
})

let splitterContainerObserver: ResizeObserver | null = null
let timelineAlignmentResizeObserver: ResizeObserver | null = null
let timelineAlignmentMutationObserver: MutationObserver | null = null

function readTimelineRightInsetPx(): number {
  if (scheduleSectionEl.value === null) {
    return 0
  }

  const scheduleContentEl = scheduleSectionEl.value.querySelector<HTMLElement>('.gnaural-schedule-view__content')
  const scheduleMainCanvasEl = scheduleSectionEl.value.querySelector<HTMLElement>('.gnaural-schedule-view__main-canvas')
  if (scheduleContentEl === null || scheduleMainCanvasEl === null) {
    return 0
  }

  const scheduleContentRect = scheduleContentEl.getBoundingClientRect()
  const scheduleMainCanvasRect = scheduleMainCanvasEl.getBoundingClientRect()
  const schedulePlotRight = scheduleMainCanvasRect.right - GNAURAL_MAIN_PLOT_RIGHT_GUTTER_PX
  return Math.max(0, Math.round(scheduleContentRect.right - schedulePlotRight))
}

function updateTimelineAlignmentInset(): void {
  timelineRightInsetPx.value = readTimelineRightInsetPx()
}

function reconnectTimelineAlignmentObservers(): void {
  timelineAlignmentResizeObserver?.disconnect()
  timelineAlignmentMutationObserver?.disconnect()

  if (scheduleSectionEl.value === null || !hasSchedule.value) {
    timelineRightInsetPx.value = 0
    return
  }

  timelineAlignmentResizeObserver = new ResizeObserver(() => {
    updateTimelineAlignmentInset()
  })

  timelineAlignmentResizeObserver.observe(scheduleSectionEl.value)

  const scheduleContentEl = scheduleSectionEl.value.querySelector<HTMLElement>('.gnaural-schedule-view__content')
  if (scheduleContentEl !== null) {
    timelineAlignmentResizeObserver.observe(scheduleContentEl)
  }

  const scheduleCanvasColumnEl = scheduleSectionEl.value.querySelector<HTMLElement>('.gnaural-schedule-view__canvas-column')
  if (scheduleCanvasColumnEl !== null) {
    timelineAlignmentResizeObserver.observe(scheduleCanvasColumnEl)
  }

  const scheduleMainCanvasEl = scheduleSectionEl.value.querySelector<HTMLElement>('.gnaural-schedule-view__main-canvas')
  if (scheduleMainCanvasEl !== null) {
    timelineAlignmentResizeObserver.observe(scheduleMainCanvasEl)
  }

  const scheduleTracksPanelEl = scheduleSectionEl.value.querySelector<HTMLElement>('.gnaural-schedule-view__tracks-panel')
  if (scheduleTracksPanelEl !== null) {
    timelineAlignmentResizeObserver.observe(scheduleTracksPanelEl)
  }

  timelineAlignmentMutationObserver = new MutationObserver(() => {
    reconnectTimelineAlignmentObservers()
  })

  timelineAlignmentMutationObserver.observe(scheduleSectionEl.value, {
    childList: true,
    subtree: true,
  })

  updateTimelineAlignmentInset()
}
onMounted(() => {
  splitterContainerObserver = new ResizeObserver((entries) => {
    splitterContainerHeight.value = entries[0]?.contentRect.height ?? 0
  })

  watch(
    splitterContainerEl,
    (element) => {
      splitterContainerObserver!.disconnect()
      if (element !== null) {
        splitterContainerObserver!.observe(element)
      }
    },
    { immediate: true },
  )
})

onBeforeUnmount(() => {
  splitterContainerObserver?.disconnect()
  splitterContainerObserver = null
  timelineAlignmentResizeObserver?.disconnect()
  timelineAlignmentResizeObserver = null
  timelineAlignmentMutationObserver?.disconnect()
  timelineAlignmentMutationObserver = null
})

const session = computed(() => replay.getReplaySessionState(props.sessionId))
const sessionTitle = computed(() => {
  return session.value?.sessionName ?? `${t('archive.replayTabTitleFallback')} #${props.sessionId}`
})
const statusText = computed(() => {
  if (session.value === null) {
    return t('archive.replayClosedHint')
  }

  if (session.value.startPending) {
    return t('archive.replayStatusStarting')
  }

  switch (session.value.status) {
    case 'playing':
      return t('archive.replayStatusPlaying')
    case 'paused':
      return t('archive.replayStatusPaused')
    case 'finished':
      return t('archive.replayStatusFinished')
    case 'stopped':
      return t('archive.replayStatusStopped')
    default:
      return t('archive.replayStatusReady')
  }
})
const statusChipLabel = computed(() => {
  if (session.value?.transportActive) {
    return t('archive.replayBadgeShortPlaying')
  }

  return t('archive.replayBadgeShortReady')
})

const chartData = computed(() => session.value?.chartData ?? null)
const isChartLoading = computed(() => session.value?.chartLoading ?? false)
const chartError = computed(() => session.value?.chartError ?? null)
const sessionError = computed(() => session.value?.error ?? null)
const hasChartData = computed(() => chartData.value !== null && hasLogChartData(chartData.value))
const hasEegData = computed(() =>
  chartData.value?.series.some((series) => series.panel === 'eeg' && series.points.length > 0) ?? false,
)
const isStandaloneEegMode = true

const eegModeOptions = computed<EegModeOption[]>(() => [
  { value: 'bands', icon: 'bar_chart', tooltip: t('monitoring.eegMode.bands') },
  { value: 'radar', icon: 'radar', tooltip: t('monitoring.eegMode.radar') },
])

const replayTimeSliderMinTimestampMs = computed(() => {
  return chartData.value?.minTimestampMs ?? 0
})
const replayTimeSliderMaxTimestampMs = computed(() => {
  return chartData.value?.maxTimestampMs ?? replayTimeSliderMinTimestampMs.value
})

const sessionSliderMs = ref(0)
const isSessionSliderDragging = ref(false)

const displayedReplayTimestampMs = computed<number | null>(() => {
  if (session.value === null) {
    return null
  }

  const fallbackTimestampMs = session.value.cursorTimestampMs ?? session.value.sessionStartMs
  if (
    chartData.value === null
    || chartData.value.minTimestampMs === null
    || chartData.value.maxTimestampMs === null
  ) {
    return fallbackTimestampMs
  }

  const nextTimestampMs = Number.isFinite(sessionSliderMs.value)
    ? sessionSliderMs.value
    : (fallbackTimestampMs ?? chartData.value.minTimestampMs)

  return clampReplayTimestampMs(
    nextTimestampMs,
    replayTimeSliderMinTimestampMs.value,
    replayTimeSliderMaxTimestampMs.value,
  )
})

const sessionSliderDurationLabel = computed(() => {
  return formatDurationLabel(Math.max(0, replayTimeSliderMaxTimestampMs.value - replayTimeSliderMinTimestampMs.value))
})

const sessionSliderElapsedLabel = computed(() => {
  const baselineMs = replayTimeSliderMinTimestampMs.value
  const displayedTimestampMs = displayedReplayTimestampMs.value ?? sessionSliderMs.value
  return formatDurationLabel(Math.max(0, displayedTimestampMs - baselineMs))
})

const sessionSliderProgressLabel = computed(() => {
  const baselineTimestampMsRaw = replayTimeSliderMinTimestampMs.value
  const displayedTimestampMsRaw = displayedReplayTimestampMs.value ?? sessionSliderMs.value
  const maxTimestampMsRaw = replayTimeSliderMaxTimestampMs.value

  const baselineTimestampMs = Number.isFinite(baselineTimestampMsRaw) ? baselineTimestampMsRaw : 0
  const displayedTimestampMs = Number.isFinite(displayedTimestampMsRaw)
    ? displayedTimestampMsRaw
    : baselineTimestampMs
  const maxTimestampMs = Number.isFinite(maxTimestampMsRaw)
    ? Math.max(baselineTimestampMs, maxTimestampMsRaw)
    : baselineTimestampMs

  const totalSeconds = Math.max(0, Math.floor((maxTimestampMs - baselineTimestampMs) / 1000))
  const currentSeconds = Math.min(
    totalSeconds,
    Math.max(0, Math.floor((displayedTimestampMs - baselineTimestampMs) / 1000)),
  )

  return `${currentSeconds}/${totalSeconds}`
})

const currentSchedule = computed(() => session.value?.audioSchedule ?? null)
const hasSchedule = computed(() => currentSchedule.value !== null)
const scheduleScope = computed(() => `archive-replay-${props.sessionId}`)

watch(
  [scheduleSectionEl, hasSchedule],
  async ([sectionEl, scheduleAvailable]) => {
    if (sectionEl === null || !scheduleAvailable) {
      timelineAlignmentResizeObserver?.disconnect()
      timelineAlignmentMutationObserver?.disconnect()
      timelineRightInsetPx.value = 0
      return
    }

    await nextTick()
    reconnectTimelineAlignmentObservers()
  },
  { immediate: true },
)

const schedulePositionSec = computed(() => {
  const baseTimestampMs = session.value?.audioScheduleStartedAtMs ?? session.value?.sessionStartMs ?? null
  const cursorTimestampMs = displayedReplayTimestampMs.value
  if (baseTimestampMs === null || cursorTimestampMs === null) {
    return 0
  }

  const elapsedSec = Math.max(0, (cursorTimestampMs - baseTimestampMs) / 1000)
  const singleLoopDurationSec = currentSchedule.value?.totalTimeSec ?? 0
  if (singleLoopDurationSec <= 0) {
    return elapsedSec
  }
  return elapsedSec % singleLoopDurationSec
})

const scheduleTransportState = computed(() => {
  return session.value?.status === 'playing' ? 'playing' : 'paused'
})

const replayConnectionState = computed(() => wsService.connectionState.value)
const playControlHint = computed(() => {
  if (session.value === null) {
    return null
  }

  if (replayConnectionState.value === 'connecting') {
    return t('archive.replayControlConnecting')
  }

  if (replayConnectionState.value === 'disconnected') {
    return t('archive.replayControlDisconnected')
  }

  return null
})
const playControlTitle = computed(() => playControlHint.value ?? (session.value === null ? t('archive.replayClosedHint') : null))
const replayCommandUnavailableMessage = computed(() => t('archive.replayCommandUnavailable'))
const canUseControls = computed(() => session.value !== null && replayConnectionState.value === 'connected')
const canSeekReplay = computed(() => {
  if (session.value === null) {
    return false
  }

  if (session.value.startPending) {
    return false
  }

  return session.value.transportActive
    || session.value.status === 'playing'
    || session.value.status === 'paused'
    || session.value.status === 'finished'
})
const scheduleCanSeek = computed(() => {
  if (session.value === null || !canSeekReplay.value) {
    return false
  }

  return (session.value.audioScheduleStartedAtMs ?? session.value.sessionStartMs) !== null
})
const isPlaying = computed(() => session.value?.status === 'playing')
const selectedDevices = computed(() => session.value?.selectedDevices ?? [])

watch(
  () => [session.value?.cursorTimestampMs ?? null, replayTimeSliderMinTimestampMs.value, replayTimeSliderMaxTimestampMs.value],
  ([cursorTimestampMs, minTimestampMs, maxTimestampMs]) => {
    if (isSessionSliderDragging.value) {
      return
    }

    const normalizedMinTimestampMsRaw = Number(minTimestampMs)
    const normalizedMinTimestampMs = Number.isFinite(normalizedMinTimestampMsRaw) ? normalizedMinTimestampMsRaw : 0
    const normalizedMaxTimestampMsRaw = Number(maxTimestampMs)
    const normalizedMaxTimestampMs = Number.isFinite(normalizedMaxTimestampMsRaw)
      ? Math.max(normalizedMinTimestampMs, normalizedMaxTimestampMsRaw)
      : normalizedMinTimestampMs
    const fallbackTimestampMs = typeof cursorTimestampMs === 'number' && Number.isFinite(cursorTimestampMs)
      ? cursorTimestampMs
      : normalizedMinTimestampMs

    sessionSliderMs.value = clampReplayTimestampMs(
      fallbackTimestampMs,
      normalizedMinTimestampMs,
      normalizedMaxTimestampMs,
    )
  },
  { immediate: true },
)

function clampReplayTimestampMs(value: number, minTimestampMs: number, maxTimestampMs: number): number {
  return Math.max(minTimestampMs, Math.min(value, maxTimestampMs))
}

function formatDurationLabel(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
}

function capabilityLabel(capability: string): string {
  const key = `capability.${capability}`
  const translated = t(key)
  return translated === key ? capability : translated
}

function emitClose() {
  emit('close')
}

function activateCurrentSession(): boolean {
  return replay.activateReplaySession(props.sessionId)
}

function setSessionError(message: string | null): void {
  replay.setReplaySessionError(props.sessionId, message)
}

function getReplayStartTimestampMs(): number {
  const minTimestampMs = replayTimeSliderMinTimestampMs.value
  const maxTimestampMs = replayTimeSliderMaxTimestampMs.value
  const timestampMs = session.value?.status === 'finished' ? minTimestampMs : sessionSliderMs.value

  return clampReplayTimestampMs(timestampMs, minTimestampMs, maxTimestampMs)
}

function handlePlayStop() {
  if (!activateCurrentSession() || session.value === null) {
    return
  }

  if (session.value.status === 'playing') {
    if (replay.pauseReplaySession(props.sessionId)) {
      setSessionError(null)
    } else {
      setSessionError(playControlHint.value ?? replayCommandUnavailableMessage.value)
    }
    return
  }

  if (!replay.startReplay(props.sessionId, getReplayStartTimestampMs())) {
    setSessionError(playControlHint.value ?? replayCommandUnavailableMessage.value)
  }
}

function setReplaySpeed(speed: ReplaySpeed) {
  if (!activateCurrentSession()) {
    return
  }

  replay.setReplaySpeed(speed)
}

function handleSessionSliderInput(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return
  }

  isSessionSliderDragging.value = true
  sessionSliderMs.value = clampReplayTimestampMs(
    value,
    replayTimeSliderMinTimestampMs.value,
    replayTimeSliderMaxTimestampMs.value,
  )
}

function handleSessionSeek(value: number | null) {
  isSessionSliderDragging.value = false

  if (value === null || !Number.isFinite(value)) {
    return
  }

  const nextTimestampMs = clampReplayTimestampMs(
    value,
    replayTimeSliderMinTimestampMs.value,
    replayTimeSliderMaxTimestampMs.value,
  )
  sessionSliderMs.value = nextTimestampMs

  if (!canSeekReplay.value) {
    return
  }

  if (!activateCurrentSession()) {
    return
  }

  replay.seekReplay(nextTimestampMs)
}

function handleScheduleSeek(positionSec: number) {
  const baseTimestampMs = session.value?.audioScheduleStartedAtMs ?? session.value?.sessionStartMs ?? null
  if (baseTimestampMs === null) {
    return
  }

  if (!canSeekReplay.value) {
    return
  }

  if (!activateCurrentSession()) {
    return
  }

  const nextTimestampMs = Math.max(0, Math.round(baseTimestampMs + positionSec * 1000))
  replay.seekReplay(nextTimestampMs)
}
</script>

<style scoped>
.archive-replay-view {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.archive-replay-view__card {
  background: rgba(15, 23, 42, 0.32);
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.archive-replay-view__split-section {
  display: flex;
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
}

.archive-replay-view__splitter-container {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}

.archive-replay-view__splitter {
  flex: 1 1 auto;
  min-height: 0;
}

.archive-replay-view__splitter:deep(.q-splitter__before),
.archive-replay-view__splitter:deep(.q-splitter__after) {
  overflow: hidden;
}

.archive-replay-view__pane {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.archive-replay-view__pane--chart {
  padding-bottom: 0px;
}

.archive-replay-view__header-row {
  min-height: 56px;
}

.archive-replay-view__header-devices {
  align-items: center;
  display: flex;
  justify-content: center;
  min-width: 0;
}

.archive-replay-view__header-devices-content {
  align-items: center;
  justify-content: center;
  min-width: 0;
}

.archive-replay-view__header-devices-label {
  flex: 0 0 auto;
}

.archive-replay-view__controls {
  align-items: center;
}

.archive-replay-view__mode-group {
  flex: 0 0 auto;
}

.archive-replay-view__slider {
  min-width: 0;
}

.archive-replay-view__timeline {
  align-items: flex-start;
  flex: 0 0 auto;
  margin-top: auto;
}

.archive-replay-view__timeline-track {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.archive-replay-view__timeline-end-labels {
  align-items: center;
  display: flex;
  gap: 12px;
  justify-content: space-between;
  line-height: 1;
  transform: translateY(-45%);
}

.archive-replay-view__device-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.archive-replay-view__device-list--header {
  justify-content: center;
}

.archive-replay-view__chart-section,
.archive-replay-view__schedule-section {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}

.archive-replay-view__chart {
  flex: 1 1 auto;
  min-height: 0;
}

.archive-replay-view__schedule {
  flex: 1 1 auto;
  min-height: 0;
}

.archive-replay-view__placeholder {
  flex: 1 1 auto;
  min-height: 220px;
}
</style>