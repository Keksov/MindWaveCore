import {
  EEG_SNAPSHOT_SERIES_KEYS,
  LOG_CHART_SERIES_META,
  LOG_CHART_SERIES_ORDER,
  createEmptyLogChartDataSnapshot,
  getRuntimeEventTimestampMs,
  parseBreathPhaseEvent,
  parseHrNotificationEvent,
  parseSnapshotEvent,
  type LogChartDataSnapshot,
  type LogChartPoint,
  type LogChartSeries,
  type LogChartSeriesKey,
} from '@protocol'

export const DEFAULT_LIVE_CHART_MAX_POINTS = 3600

interface PendingPointUpdate {
  readonly key: LogChartSeriesKey
  readonly point: LogChartPoint
}

const trimPoints = (points: readonly LogChartPoint[], maxPoints: number): readonly LogChartPoint[] => {
  if (points.length <= maxPoints) {
    return points
  }

  return points.slice(points.length - maxPoints)
}

const withUpdatedSeries = (
  snapshot: LogChartDataSnapshot,
  updates: readonly PendingPointUpdate[],
  maxPoints: number,
): LogChartDataSnapshot => {
  if (updates.length === 0) {
    return snapshot
  }

  const seriesByKey = new Map<LogChartSeriesKey, LogChartSeries>(
    snapshot.series.map((series) => [series.key, series]),
  )

  const updatesByKey = new Map<LogChartSeriesKey, LogChartPoint[]>()
  for (const update of updates) {
    const points = updatesByKey.get(update.key) ?? []
    points.push(update.point)
    updatesByKey.set(update.key, points)
  }

  let minTimestampMs = snapshot.minTimestampMs
  let maxTimestampMs = snapshot.maxTimestampMs

  for (const update of updates) {
    minTimestampMs = minTimestampMs === null ? update.point[0] : Math.min(minTimestampMs, update.point[0])
    maxTimestampMs = maxTimestampMs === null ? update.point[0] : Math.max(maxTimestampMs, update.point[0])
  }

  const nextSeries = LOG_CHART_SERIES_ORDER.map((key) => {
    const currentSeries = seriesByKey.get(key) ?? {
      key,
      ...LOG_CHART_SERIES_META[key],
      points: [],
    }

    const nextPoints = updatesByKey.get(key)
    if (nextPoints === undefined) {
      return currentSeries
    }

    return {
      ...currentSeries,
      points: trimPoints([...currentSeries.points, ...nextPoints], maxPoints),
    }
  })

  return {
    series: nextSeries,
    minTimestampMs,
    maxTimestampMs,
  }
}

export const appendParsedOutputToLogChart = (
  snapshot: LogChartDataSnapshot,
  parsedJson: unknown,
  fallbackTimestampMs = Date.now(),
  maxPoints = DEFAULT_LIVE_CHART_MAX_POINTS,
): LogChartDataSnapshot => {
  const timestampMs = getRuntimeEventTimestampMs(parsedJson) ?? fallbackTimestampMs
  const updates: PendingPointUpdate[] = []

  const hrEvent = parseHrNotificationEvent(parsedJson)
  if (hrEvent !== null) {
    updates.push({ key: 'hr', point: [timestampMs, hrEvent.hr] })

    let rrTimestampMs = timestampMs
    const rrPoints: LogChartPoint[] = []
    for (let index = hrEvent.rr.length - 1; index >= 0; index -= 1) {
      const rrValueMs = hrEvent.rr[index]
      rrPoints.push([Math.round(rrTimestampMs), rrValueMs])
      rrTimestampMs -= rrValueMs
    }

    rrPoints.reverse()
    for (const point of rrPoints) {
      updates.push({ key: 'rr', point })
    }
  }

  const breathEvent = parseBreathPhaseEvent(parsedJson)
  if (breathEvent !== null) {
    updates.push({
      key: 'breath_phase',
      point: [timestampMs, breathEvent.phase === 'inhale' ? 1 : -1],
    })
  }

  const snapshotEvent = parseSnapshotEvent(parsedJson)
  if (snapshotEvent !== null) {
    for (const key of EEG_SNAPSHOT_SERIES_KEYS) {
      const value = snapshotEvent[key]
      if (value === undefined) {
        continue
      }

      updates.push({ key, point: [timestampMs, value] })
    }
  }

  return withUpdatedSeries(snapshot, updates, maxPoints)
}

export const createEmptyChartSnapshot = (): LogChartDataSnapshot => {
  return createEmptyLogChartDataSnapshot()
}

export const hasLogChartData = (snapshot: LogChartDataSnapshot | null | undefined): boolean => {
  return snapshot !== null && snapshot !== undefined && snapshot.series.some((series) => series.points.length > 0)
}