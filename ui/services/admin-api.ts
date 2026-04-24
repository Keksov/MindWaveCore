export interface AdminBunActionStatusResponse {
  readonly canRestartBun: boolean
  readonly restartBunReason: string | null
  readonly isWatchMode: boolean
}

export type AdminBunActionName = 'build_ui' | 'restart_exe' | 'restart_bun'
export type AdminBunActionState = 'completed' | 'scheduled'

export interface AdminBunActionResponse {
  readonly action: AdminBunActionName
  readonly status: AdminBunActionState
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

function parseJsonText(text: string, errorMessage: string): unknown {
  if (text === '') {
    return null
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(errorMessage)
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  const text = await response.text()
  const payload = parseJsonText(text, `Invalid JSON response from ${path}`)

  if (!response.ok) {
    if (isRecord(payload) && typeof payload.error === 'string') {
      throw new Error(payload.error)
    }

    throw new Error(`Request failed with status ${response.status}`)
  }

  return payload as T
}

export const adminApi = {
  fetchBunActionStatus(): Promise<AdminBunActionStatusResponse> {
    return requestJson<AdminBunActionStatusResponse>('/api/admin/bun-actions', {
      method: 'GET',
    })
  },

  buildUi(): Promise<AdminBunActionResponse> {
    return requestJson<AdminBunActionResponse>('/api/admin/bun-actions/build-ui', {
      method: 'POST',
    })
  },

  restartExe(): Promise<AdminBunActionResponse> {
    return requestJson<AdminBunActionResponse>('/api/admin/bun-actions/restart-exe', {
      method: 'POST',
    })
  },

  restartBun(): Promise<AdminBunActionResponse> {
    return requestJson<AdminBunActionResponse>('/api/admin/bun-actions/restart-bun', {
      method: 'POST',
    })
  },
} as const