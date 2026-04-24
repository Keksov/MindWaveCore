import type {
  ArchivedLogChartData,
  ArchivedLogDetail,
  ArchivedLogEventRecord,
  ArchivedLogListResult,
  LogSettings,
} from '@protocol'

interface LogEventsResponse {
  readonly items: readonly ArchivedLogEventRecord[]
  readonly nextCursor: number
}

export interface FetchLogsOptions {
  readonly favorite?: boolean
  readonly q?: string
  readonly tag?: string
  readonly page?: number
  readonly pageSize?: number
}

export interface UpdateLogInput {
  readonly customName?: string | null
  readonly isFavorite?: boolean
  readonly tags?: readonly string[] | null
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  if (response.status === 204) {
    return undefined as T
  }

  const text = await response.text()
  const payload = text === '' ? null : JSON.parse(text) as unknown

  if (!response.ok) {
    if (isRecord(payload) && typeof payload.error === 'string') {
      throw new Error(payload.error)
    }

    throw new Error(`Request failed with status ${response.status}`)
  }

  return payload as T
}

function buildQuery(options: FetchLogsOptions): string {
  const params = new URLSearchParams()

  if (options.favorite !== undefined) {
    params.set('favorite', options.favorite ? 'true' : 'false')
  }

  if (options.q && options.q.trim() !== '') {
    params.set('q', options.q.trim())
  }

  if (options.tag && options.tag.trim() !== '') {
    params.set('tag', options.tag.trim())
  }

  if (options.page !== undefined) {
    params.set('page', String(options.page))
  }

  if (options.pageSize !== undefined) {
    params.set('pageSize', String(options.pageSize))
  }

  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

export const logsApi = {
  fetchLogs(options: FetchLogsOptions = {}): Promise<ArchivedLogListResult> {
    return requestJson<ArchivedLogListResult>(`/api/logs${buildQuery(options)}`, { method: 'GET' })
  },

  fetchLog(sessionId: number): Promise<ArchivedLogDetail> {
    return requestJson<ArchivedLogDetail>(`/api/logs/${sessionId}`, { method: 'GET' })
  },

  fetchLogEvents(sessionId: number, cursor = 0, limit = 500): Promise<LogEventsResponse> {
    const query = new URLSearchParams({
      cursor: String(cursor),
      limit: String(limit),
    })

    return requestJson<LogEventsResponse>(`/api/logs/${sessionId}/events?${query.toString()}`, { method: 'GET' })
  },

  fetchLogChart(sessionId: number): Promise<ArchivedLogChartData> {
    return requestJson<ArchivedLogChartData>(`/api/logs/${sessionId}/chart`, { method: 'GET' })
  },

  updateLog(sessionId: number, input: UpdateLogInput): Promise<ArchivedLogDetail> {
    return requestJson<ArchivedLogDetail>(`/api/logs/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  },

  async deleteLog(sessionId: number): Promise<void> {
    await requestJson<void>(`/api/logs/${sessionId}`, { method: 'DELETE' })
  },

  fetchLogSettings(): Promise<LogSettings> {
    return requestJson<LogSettings>('/api/log-settings', { method: 'GET' })
  },

  updateLogSettings(retentionDays: number): Promise<LogSettings> {
    return requestJson<LogSettings>('/api/log-settings', {
      method: 'PATCH',
      body: JSON.stringify({ retentionDays }),
    })
  },
} as const
