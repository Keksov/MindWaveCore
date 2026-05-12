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
          <div v-if="selectedDevices.length > 0" class="archive-replay-view__header-devices-content">
            <div class="archive-replay-view__header-devices-main row items-center q-gutter-sm">
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

            <div
              v-if="headerSignalBadgeText !== null"
              class="archive-replay-view__header-signal-badge"
              :style="{ color: headerSignalBadgeColor }"
            >
              {{ headerSignalBadgeText }}
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

          <eeg-chart-settings-bar
            v-if="hasEegData"
            :window-sec="replayWindowSec"
            :data-correction="replayDataCorrection"
            :can-use-calibrated="false"
            :calibrated-tooltip="$t('monitoring.calibration.replayUnsupported')"
            :data-source="replayDataSource"
            @update:window-sec="replayWindowSec = $event"
            @update:data-correction="replayDataCorrection = $event"
            @update:data-source="replayDataSource = $event"
          />

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
                        :window-sec="replayWindowSec"
                        :data-correction="replayDataCorrection"
                        :data-source="replayDataSource"
                        show-signal-badge
                      />

                      <eeg-radar-chart
                        v-else
                        class="archive-replay-view__chart"
                        :data="chartData"
                        :anchor-timestamp-ms="displayedReplayTimestampMs"
                        :window-sec="replayWindowSec"
                        :data-correction="replayDataCorrection"
                        :data-source="replayDataSource"
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
                    <div
                      v-if="showTimelineDominantBandBar"
                      class="archive-replay-view__timeline-dominant-band-bar"
                      :style="timelineDominantBandBarStyle"
                      aria-hidden="true"
                    />

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

                    <div
                      v-if="showTimelineSignalBar"
                      class="archive-replay-view__timeline-signal-bar"
                      :style="timelineSignalBarStyle"
                      aria-hidden="true"
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
                  :window-sec="replayWindowSec"
                  :data-correction="replayDataCorrection"
                  :data-source="replayDataSource"
                  show-signal-badge
                />

                <eeg-radar-chart
                  v-else
                  class="archive-replay-view__chart"
                  :data="chartData"
                  :anchor-timestamp-ms="displayedReplayTimestampMs"
                  :window-sec="replayWindowSec"
                  :data-correction="replayDataCorrection"
                  :data-source="replayDataSource"
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
              <div
                v-if="showTimelineDominantBandBar"
                class="archive-replay-view__timeline-dominant-band-bar"
                :style="timelineDominantBandBarStyle"
                aria-hidden="true"
              />

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

              <div
                v-if="showTimelineSignalBar"
                class="archive-replay-view__timeline-signal-bar"
                :style="timelineSignalBarStyle"
                aria-hidden="true"
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
import { EEG_BAND_COLORS } from '../../../BodyMonitorCore/ui/services/eeg-band-colors'
import { EEG_BAND_KEYS, type EegBandKey } from '../../../BodyMonitorCore/ui/services/eeg-band-snapshot'
import type { EegDataCorrection, EegDataSource } from '../../../BodyMonitorCore/ui/stores/preferences'
import { usePreferencesStore } from '../../../BodyMonitorCore/ui/stores/preferences'
import { hasLogChartData } from '../../../SharedPasCore/ts/log-chart'
import { wsService } from 'src/services/ws'
import { useReplayStore } from 'stores/replay'

const DeviceDataChart = defineAsyncComponent(() => import('../../../BodyMonitorCore/ui/components/DeviceDataChart.vue'))
const EegRadarChart = defineAsyncComponent(() => import('../../../BodyMonitorCore/ui/components/EegRadarChart.vue'))
const EegCurrentReadingsChart = defineAsyncComponent(() => import('../../../BodyMonitorCore/ui/components/EegCurrentReadingsChart.vue'))
const EegChartSettingsBar = defineAsyncComponent(() => import('../../../BodyMonitorCore/ui/components/EegChartSettingsBar.vue'))
const GnauralScheduleView = defineAsyncComponent(() => import('../../../GnauralCore/ui/components/GnauralScheduleView.vue'))

const props = defineProps<{
  readonly sessionId: number
}>()

const emit = defineEmits<{
  close: []
}>()

const replay = useReplayStore()
const { t } = useI18n()

const _preferences = usePreferencesStore()

type ReplayEegMode = 'bands' | 'radar'

interface EegModeOption {
  readonly value: ReplayEegMode
  readonly icon: string
  readonly tooltip: string
}

const replaySpeedOptions = [1, 2, 4, 10] as const
const replayEegMode = ref<ReplayEegMode>('radar')
const replayWindowSec = ref<number>(_preferences.eegBandWindowSec)
const replayDataCorrection = ref<EegDataCorrection>(
  _preferences.eegDataCorrection === 'calibrated' ? 'raw' : _preferences.eegDataCorrection,
)
const replayDataSource = ref<EegDataSource>(_preferences.eegDataSource)

const REPLAY_SPLIT_STORAGE_KEY = 'archive-replay-split-px'
const REPLAY_SPLIT_DEFAULT = 400
const REPLAY_SPLIT_CHART_MIN = 200
const REPLAY_SPLIT_AUDIO_MIN = 320
const GNAURAL_MAIN_PLOT_RIGHT_GUTTER_PX = 44
const TIMELINE_SIGNAL_NEUTRAL_COLOR = '#5f6b76'
const TIMELINE_SIGNAL_GOOD_COLOR = '#2fbf71'
const TIMELINE_SIGNAL_FAIR_COLOR = '#f3c64d'
const TIMELINE_SIGNAL_POOR_COLOR = '#e25a5a'
const TIMELINE_SIGNAL_SAMPLE_COUNT = 240
const SIGNAL_BADGE_NONE_COLOR = '#9aa5b1'
const SIGNAL_BADGE_GOOD_COLOR = '#43aa8b'
const SIGNAL_BADGE_FAIR_COLOR = '#f9c74f'
const SIGNAL_BADGE_POOR_COLOR = '#e76f51'
const replayErrorTranslationKeys = new Map<string, string>([
  ['Stop the active scan or monitoring session before replay', 'archive.replayStopActiveSessionBeforeReplay'],
])

type TimelineSignalPoint = readonly [timestampMs: number, value: number]
type TimelineEegSeriesByBand = Record<EegBandKey, readonly TimelineSignalPoint[]>

function interpolateHexColor(startHex: string, endHex: string, ratio: number): string {
  const normalizedRatio = Math.max(0, Math.min(1, ratio))
  const startValue = parseInt(startHex.slice(1), 16)
  const endValue = parseInt(endHex.slice(1), 16)
  const startRed = (startValue >> 16) & 0xff
  const startGreen = (startValue >> 8) & 0xff
  const startBlue = startValue & 0xff
  const endRed = (endValue >> 16) & 0xff
  const endGreen = (endValue >> 8) & 0xff
  const endBlue = endValue & 0xff
  const red = Math.round(startRed + ((endRed - startRed) * normalizedRatio))
  const green = Math.round(startGreen + ((endGreen - startGreen) * normalizedRatio))
  const blue = Math.round(startBlue + ((endBlue - startBlue) * normalizedRatio))

  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

function poorSignalToColor(value: number): string {
  if (!Number.isFinite(value)) {
    return TIMELINE_SIGNAL_NEUTRAL_COLOR
  }

  const normalizedValue = Math.max(0, Math.min(200, value))
  if (normalizedValue <= 25) {
    return interpolateHexColor(
      TIMELINE_SIGNAL_GOOD_COLOR,
      TIMELINE_SIGNAL_FAIR_COLOR,
      normalizedValue / 25,
    )
  }

  return interpolateHexColor(
    TIMELINE_SIGNAL_FAIR_COLOR,
    TIMELINE_SIGNAL_POOR_COLOR,
    (normalizedValue - 25) / 175,
  )
}

function getPoorSignalAtTimestamp(
  points: readonly TimelineSignalPoint[],
  anchorTimestampMs: number | null,
): number | null {
  if (points.length === 0) {
    return null
  }

  if (anchorTimestampMs === null || !Number.isFinite(anchorTimestampMs)) {
    return points[points.length - 1]?.[1] ?? null
  }

  return getLatestPointValueAtTimestamp(points, anchorTimestampMs)
}

function getLatestPointValueAtTimestamp(
  points: readonly TimelineSignalPoint[],
  anchorTimestampMs: number,
): number | null {
  if (points.length === 0 || !Number.isFinite(anchorTimestampMs)) {
    return null
  }

  let latestValue: number | null = null
  for (const [timestampMs, value] of points) {
    if (timestampMs > anchorTimestampMs) {
      break
    }

    latestValue = value
  }

  if (latestValue !== null) {
    return latestValue
  }

  return points[0]?.[1] ?? null
}

function resolveDominantEegBandAtTimestamp(
  seriesByBand: Readonly<TimelineEegSeriesByBand>,
  anchorTimestampMs: number,
): EegBandKey | null {
  let dominantBand: EegBandKey | null = null
  let dominantValue = Number.NEGATIVE_INFINITY

  for (const bandKey of EEG_BAND_KEYS) {
    const value = getLatestPointValueAtTimestamp(seriesByBand[bandKey], anchorTimestampMs)
    if (value === null || !Number.isFinite(value)) {
      continue
    }

    if (dominantBand === null || value > dominantValue) {
      dominantBand = bandKey
      dominantValue = value
    }
  }

  return dominantBand
}

function toSignalQualityPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null
  }

  const clampedValue = Math.max(0, Math.min(200, value))
  return Math.round((1 - (clampedValue / 200)) * 100)
}

function poorSignalBadgeText(value: number | null): string {
  if (value === null) return t('monitoring.badge.signalNone')

  const qualityPercent = toSignalQualityPercent(value)
  const suffix = qualityPercent === null ? '' : ` ${qualityPercent}%`

  if (value === 0) return `${t('monitoring.badge.signalGood')}${suffix}`
  if (value <= 25) return `${t('monitoring.badge.signalFair')}${suffix}`
  return `${t('monitoring.badge.signalPoor')}${suffix}`
}

function poorSignalBadgeColor(value: number | null): string {
  if (value === null) return SIGNAL_BADGE_NONE_COLOR
  if (value === 0) return SIGNAL_BADGE_GOOD_COLOR
  if (value <= 25) return SIGNAL_BADGE_FAIR_COLOR
  return SIGNAL_BADGE_POOR_COLOR
}

function localizeReplayError(message: string | null): string | null {
  if (message === null) {
    return null
  }

  const translationKey = replayErrorTranslationKeys.get(message)
  if (translationKey === undefined) {
    return message
  }

  return t(translationKey)
}

function buildTimelineSignalGradient(
  points: readonly TimelineSignalPoint[],
  minTimestampMs: number,
  maxTimestampMs: number,
): string {
  if (points.length === 0) {
    return TIMELINE_SIGNAL_NEUTRAL_COLOR
  }

  const safeMinTimestampMs = Number.isFinite(minTimestampMs) ? minTimestampMs : 0
  const safeMaxTimestampMs = Number.isFinite(maxTimestampMs)
    ? Math.max(safeMinTimestampMs, maxTimestampMs)
    : safeMinTimestampMs
  const durationMs = safeMaxTimestampMs - safeMinTimestampMs
  if (durationMs <= 0) {
    return poorSignalToColor(points[points.length - 1]?.[1] ?? Number.NaN)
  }

  const segments: Array<{ color: string, startPercent: number, endPercent: number }> = []
  let pointIndex = 0
  let activeValue: number | null = null

  for (let sampleIndex = 0; sampleIndex < TIMELINE_SIGNAL_SAMPLE_COUNT; sampleIndex += 1) {
    const sampleTimestampMs = safeMinTimestampMs + (((sampleIndex + 0.5) / TIMELINE_SIGNAL_SAMPLE_COUNT) * durationMs)
    while (pointIndex < points.length && points[pointIndex][0] <= sampleTimestampMs) {
      activeValue = points[pointIndex][1]
      pointIndex += 1
    }

    const color = activeValue === null
      ? TIMELINE_SIGNAL_NEUTRAL_COLOR
      : poorSignalToColor(activeValue)
    const startPercent = (sampleIndex / TIMELINE_SIGNAL_SAMPLE_COUNT) * 100
    const endPercent = ((sampleIndex + 1) / TIMELINE_SIGNAL_SAMPLE_COUNT) * 100
    const previousSegment = segments[segments.length - 1]

    if (previousSegment !== undefined && previousSegment.color === color) {
      previousSegment.endPercent = endPercent
    } else {
      segments.push({ color, startPercent, endPercent })
    }
  }

  if (segments.length === 0) {
    return TIMELINE_SIGNAL_NEUTRAL_COLOR
  }

  const gradientStops = segments.flatMap((segment) => [
    `${segment.color} ${segment.startPercent.toFixed(3)}%`,
    `${segment.color} ${segment.endPercent.toFixed(3)}%`,
  ])

  return `linear-gradient(to right, ${gradientStops.join(', ')})`
}

function buildTimelineDominantBandGradient(
  seriesByBand: Readonly<TimelineEegSeriesByBand>,
  minTimestampMs: number,
  maxTimestampMs: number,
): string {
  const hasBandPoints = EEG_BAND_KEYS.some((bandKey) => seriesByBand[bandKey].length > 0)
  if (!hasBandPoints) {
    return TIMELINE_SIGNAL_NEUTRAL_COLOR
  }

  const safeMinTimestampMs = Number.isFinite(minTimestampMs) ? minTimestampMs : 0
  const safeMaxTimestampMs = Number.isFinite(maxTimestampMs)
    ? Math.max(safeMinTimestampMs, maxTimestampMs)
    : safeMinTimestampMs
  const durationMs = safeMaxTimestampMs - safeMinTimestampMs

  if (durationMs <= 0) {
    const dominantBand = resolveDominantEegBandAtTimestamp(seriesByBand, safeMaxTimestampMs)
    return dominantBand === null ? TIMELINE_SIGNAL_NEUTRAL_COLOR : EEG_BAND_COLORS[dominantBand]
  }

  const segments: Array<{ color: string, startPercent: number, endPercent: number }> = []
  const pointIndices = Object.fromEntries(
    EEG_BAND_KEYS.map((bandKey) => [bandKey, 0]),
  ) as Record<EegBandKey, number>
  const activeValues = Object.fromEntries(
    EEG_BAND_KEYS.map((bandKey) => [bandKey, null]),
  ) as Record<EegBandKey, number | null>

  for (let sampleIndex = 0; sampleIndex < TIMELINE_SIGNAL_SAMPLE_COUNT; sampleIndex += 1) {
    const sampleTimestampMs = safeMinTimestampMs + (((sampleIndex + 0.5) / TIMELINE_SIGNAL_SAMPLE_COUNT) * durationMs)

    for (const bandKey of EEG_BAND_KEYS) {
      const points = seriesByBand[bandKey]
      let pointIndex = pointIndices[bandKey]
      while (pointIndex < points.length && points[pointIndex][0] <= sampleTimestampMs) {
        activeValues[bandKey] = points[pointIndex][1]
        pointIndex += 1
      }
      pointIndices[bandKey] = pointIndex
    }

    let dominantBand: EegBandKey | null = null
    let dominantValue = Number.NEGATIVE_INFINITY
    for (const bandKey of EEG_BAND_KEYS) {
      const value = activeValues[bandKey]
      if (value === null || !Number.isFinite(value)) {
        continue
      }

      if (dominantBand === null || value > dominantValue) {
        dominantBand = bandKey
        dominantValue = value
      }
    }

    const color = dominantBand === null
      ? TIMELINE_SIGNAL_NEUTRAL_COLOR
      : EEG_BAND_COLORS[dominantBand]
    const startPercent = (sampleIndex / TIMELINE_SIGNAL_SAMPLE_COUNT) * 100
    const endPercent = ((sampleIndex + 1) / TIMELINE_SIGNAL_SAMPLE_COUNT) * 100
    const previousSegment = segments[segments.length - 1]

    if (previousSegment !== undefined && previousSegment.color === color) {
      previousSegment.endPercent = endPercent
    } else {
      segments.push({ color, startPercent, endPercent })
    }
  }

  if (segments.length === 0) {
    return TIMELINE_SIGNAL_NEUTRAL_COLOR
  }

  const gradientStops = segments.flatMap((segment) => [
    `${segment.color} ${segment.startPercent.toFixed(3)}%`,
    `${segment.color} ${segment.endPercent.toFixed(3)}%`,
  ])

  return `linear-gradient(to right, ${gradientStops.join(', ')})`
}

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
const sessionError = computed(() => localizeReplayError(session.value?.error ?? null))
const hasChartData = computed(() => chartData.value !== null && hasLogChartData(chartData.value))
const hasEegData = computed(() =>
  chartData.value?.series.some((series) => series.panel === 'eeg' && series.points.length > 0) ?? false,
)
const eegBandSeriesByKey = computed<TimelineEegSeriesByBand>(() => {
  const seriesEntries = chartData.value?.series ?? []
  return Object.fromEntries(
    EEG_BAND_KEYS.map((bandKey) => {
      const bandSeries = seriesEntries.find((series) => series.key === bandKey)
      return [bandKey, (bandSeries?.points ?? []) as readonly TimelineSignalPoint[]]
    }),
  ) as TimelineEegSeriesByBand
})
const hasThinkGearBandData = computed(() =>
  EEG_BAND_KEYS.some((bandKey) => eegBandSeriesByKey.value[bandKey].length > 0),
)
const showTimelineDominantBandBar = computed(() => replayDataSource.value === 'bands' && hasThinkGearBandData.value)
const timelineDominantBandBarStyle = computed<Record<string, string>>(() => ({
  background: buildTimelineDominantBandGradient(
    eegBandSeriesByKey.value,
    replayTimeSliderMinTimestampMs.value,
    replayTimeSliderMaxTimestampMs.value,
  ),
}))
const poorSignalSeries = computed(() => chartData.value?.series.find((series) => series.key === 'poorSignal') ?? null)
const showTimelineSignalBar = computed(() => poorSignalSeries.value?.points.length !== undefined && poorSignalSeries.value.points.length > 0)
const timelineSignalBarStyle = computed<Record<string, string>>(() => ({
  background: buildTimelineSignalGradient(
    (poorSignalSeries.value?.points ?? []) as readonly TimelineSignalPoint[],
    replayTimeSliderMinTimestampMs.value,
    replayTimeSliderMaxTimestampMs.value,
  ),
}))
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
const hasSelectedEegDevice = computed(() => {
  return selectedDevices.value.some((device) => device.capability.toLowerCase() === 'eeg')
})
const headerSignalQualityValue = computed(() => {
  if (!hasSelectedEegDevice.value) {
    return null
  }

  return getPoorSignalAtTimestamp(
    (poorSignalSeries.value?.points ?? []) as readonly TimelineSignalPoint[],
    displayedReplayTimestampMs.value,
  )
})
const headerSignalBadgeText = computed(() => {
  if (!hasSelectedEegDevice.value) {
    return null
  }

  return poorSignalBadgeText(headerSignalQualityValue.value)
})
const headerSignalBadgeColor = computed(() => {
  return poorSignalBadgeColor(headerSignalQualityValue.value)
})

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
  display: flex;
  flex-direction: column;
  gap: 4px;
  justify-content: center;
  min-width: 0;
}

.archive-replay-view__header-devices-main {
  align-items: center;
  justify-content: center;
  min-width: 0;
}

.archive-replay-view__header-devices-label {
  flex: 0 0 auto;
}

.archive-replay-view__header-signal-badge {
  background: rgba(0, 0, 0, 0.35);
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.2;
  padding: 2px 8px;
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

.archive-replay-view__slider:deep(.q-slider__track-container--h) {
  padding-top: 2px;
  padding-bottom: 1px;
}

.archive-replay-view__timeline-dominant-band-bar {
  background: #5f6b76;
  border-radius: 999px;
  flex: 0 0 auto;
  height: 4px;
  margin: 0;
  pointer-events: none;
}

.archive-replay-view__timeline-signal-bar {
  background: #5f6b76;
  border-radius: 999px;
  flex: 0 0 auto;
  height: 4px;
  margin: 1px 0 8px;
  pointer-events: none;
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