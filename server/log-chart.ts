import {
  EEG_SNAPSHOT_SERIES_KEYS,
  LOG_CHART_SERIES_META,
  LOG_CHART_SERIES_ORDER,
  getRuntimeEventTimestampMs,
  parseBreathPhaseEvent,
  parseHrNotificationEvent,
  parseSnapshotEvent,
  type ArchivedLogChartData,
  type ArchivedLogDetail,
  type ArchivedLogEventRecord,
  type LogChartPoint,
  type LogChartSeries,
  type LogChartSeriesKey,
} from "./protocol"

interface TimestampRange {
  minTimestampMs: number | null
  maxTimestampMs: number | null
}

const createSeriesBuckets = (): Record<LogChartSeriesKey, LogChartPoint[]> => {
  return Object.fromEntries(
    LOG_CHART_SERIES_ORDER.map((key) => [key, [] as LogChartPoint[]])
  ) as Record<LogChartSeriesKey, LogChartPoint[]>
}

const trackRange = (range: TimestampRange, timestampMs: number): void => {
  range.minTimestampMs = range.minTimestampMs === null
    ? timestampMs
    : Math.min(range.minTimestampMs, timestampMs)

  range.maxTimestampMs = range.maxTimestampMs === null
    ? timestampMs
    : Math.max(range.maxTimestampMs, timestampMs)
}

const resolveTimestampMs = (parsedJson: unknown, createdAt: string): number | null => {
  const runtimeTimestampMs = getRuntimeEventTimestampMs(parsedJson)
  if (runtimeTimestampMs !== null) {
    return runtimeTimestampMs
  }

  const archivedTimestampMs = Date.parse(createdAt)
  return Number.isFinite(archivedTimestampMs) ? archivedTimestampMs : null
}

const appendPoint = (
  buckets: Record<LogChartSeriesKey, LogChartPoint[]>,
  range: TimestampRange,
  key: LogChartSeriesKey,
  point: LogChartPoint,
): void => {
  buckets[key].push(point)
  trackRange(range, point[0])
}

const appendHrEvent = (
  buckets: Record<LogChartSeriesKey, LogChartPoint[]>,
  range: TimestampRange,
  timestampMs: number,
  parsedJson: unknown,
): boolean => {
  const hrEvent = parseHrNotificationEvent(parsedJson)
  if (hrEvent === null) {
    return false
  }

  appendPoint(buckets, range, "hr", [timestampMs, hrEvent.hr])

  let rrTimestampMs = timestampMs
  const rrPoints: LogChartPoint[] = []
  for (let index = hrEvent.rr.length - 1; index >= 0; index -= 1) {
    const rrValueMs = hrEvent.rr[index]
    rrPoints.push([Math.round(rrTimestampMs), rrValueMs])
    rrTimestampMs -= rrValueMs
  }

  rrPoints.reverse()
  for (const point of rrPoints) {
    appendPoint(buckets, range, "rr", point)
  }

  return true
}

const appendBreathEvent = (
  buckets: Record<LogChartSeriesKey, LogChartPoint[]>,
  range: TimestampRange,
  timestampMs: number,
  parsedJson: unknown,
): boolean => {
  const breathEvent = parseBreathPhaseEvent(parsedJson)
  if (breathEvent === null) {
    return false
  }

  appendPoint(buckets, range, "breath_phase", [timestampMs, breathEvent.phase === "inhale" ? 1 : -1])
  return true
}

const appendSnapshotEvent = (
  buckets: Record<LogChartSeriesKey, LogChartPoint[]>,
  range: TimestampRange,
  timestampMs: number,
  parsedJson: unknown,
): boolean => {
  const snapshotEvent = parseSnapshotEvent(parsedJson)
  if (snapshotEvent === null) {
    return false
  }

  for (const key of EEG_SNAPSHOT_SERIES_KEYS) {
    const value = snapshotEvent[key]
    if (value === undefined) {
      continue
    }

    appendPoint(buckets, range, key, [timestampMs, value])
  }

  return true
}

const toChartSeries = (buckets: Record<LogChartSeriesKey, LogChartPoint[]>): readonly LogChartSeries[] => {
  return LOG_CHART_SERIES_ORDER
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({
      key,
      ...LOG_CHART_SERIES_META[key],
      points: buckets[key],
    }))
}

export const buildArchivedLogChartData = (
  session: ArchivedLogDetail,
  events: readonly ArchivedLogEventRecord[],
): ArchivedLogChartData => {
  const buckets = createSeriesBuckets()
  const range: TimestampRange = {
    minTimestampMs: null,
    maxTimestampMs: null,
  }

  for (const event of events) {
    if (event.eventType !== "bodymonitor_output" || event.payload.type !== "bodymonitor_output") {
      continue
    }

    const timestampMs = resolveTimestampMs(event.payload.parsedJson, event.createdAt)
    if (timestampMs === null) {
      continue
    }

    const parsedJson = event.payload.parsedJson
    if (appendHrEvent(buckets, range, timestampMs, parsedJson)) {
      continue
    }

    if (appendBreathEvent(buckets, range, timestampMs, parsedJson)) {
      continue
    }

    void appendSnapshotEvent(buckets, range, timestampMs, parsedJson)
  }

  return {
    sessionId: session.id,
    sessionName: session.effectiveName,
    series: toChartSeries(buckets),
    minTimestampMs: range.minTimestampMs,
    maxTimestampMs: range.maxTimestampMs,
  }
}
