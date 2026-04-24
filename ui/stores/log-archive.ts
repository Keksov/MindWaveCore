import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ArchivedLogDetail, ArchivedLogSummary } from '@protocol'
import { logsApi } from 'src/services/logs-api'

const DEFAULT_PAGE_SIZE = 25

interface LoadLogsOptions {
  readonly page?: number
  readonly pageSize?: number
  readonly q?: string
  readonly favoriteOnly?: boolean
  readonly tag?: string | null
}

function normalizeTagFilter(value: string | null | undefined): string {
  if (typeof value !== 'string') {
    return ''
  }

  return value.trim().toLowerCase()
}

export const useLogArchiveStore = defineStore('log-archive', () => {
  const logs = ref<ArchivedLogSummary[]>([])
  const page = ref(1)
  const pageSize = ref(DEFAULT_PAGE_SIZE)
  const total = ref(0)
  const searchQuery = ref('')
  const favoriteOnly = ref(false)
  const activeTagFilter = ref('')
  const retentionDays = ref(30)
  const loading = ref(false)
  const settingsLoading = ref(false)
  const error = ref<string | null>(null)

  let settingsRequestId = 0

  async function loadLogs(options: LoadLogsOptions = {}) {
    if (options.page !== undefined) {
      page.value = options.page
    }

    if (options.pageSize !== undefined) {
      pageSize.value = options.pageSize
    }

    if (options.q !== undefined) {
      searchQuery.value = options.q
    }

    if (options.favoriteOnly !== undefined) {
      favoriteOnly.value = options.favoriteOnly
    }

    if (options.tag !== undefined) {
      activeTagFilter.value = normalizeTagFilter(options.tag)
    }

    loading.value = true
    error.value = null

    try {
      const result = await logsApi.fetchLogs({
        favorite: favoriteOnly.value ? true : undefined,
        q: searchQuery.value,
        tag: activeTagFilter.value === '' ? undefined : activeTagFilter.value,
        page: page.value,
        pageSize: pageSize.value,
      })

      logs.value = [...result.items]
      total.value = result.total
      page.value = result.page
      pageSize.value = result.pageSize
    } catch (loadError) {
      error.value = loadError instanceof Error ? loadError.message : 'Failed to load archived logs'
      throw loadError
    } finally {
      loading.value = false
    }
  }

  async function loadSettings() {
    settingsLoading.value = true
    error.value = null

    try {
      const settings = await logsApi.fetchLogSettings()
      retentionDays.value = settings.retentionDays
    } catch (loadError) {
      error.value = loadError instanceof Error ? loadError.message : 'Failed to load log settings'
      throw loadError
    } finally {
      settingsLoading.value = false
    }
  }

  async function saveRetentionDays(value: number) {
    const requestId = ++settingsRequestId
    settingsLoading.value = true
    error.value = null

    try {
      const settings = await logsApi.updateLogSettings(value)

      if (requestId === settingsRequestId) {
        retentionDays.value = settings.retentionDays
      }

      return settings
    } catch (saveError) {

      if (requestId === settingsRequestId) {
        error.value = saveError instanceof Error ? saveError.message : 'Failed to save log settings'
      }

      throw saveError
    } finally {
      if (requestId === settingsRequestId) {
        settingsLoading.value = false
      }
    }
  }

  async function renameLog(id: number, customName: string | null) {
    const updated = await logsApi.updateLog(id, { customName })
    await loadLogs()
    return updated
  }

  async function setFavorite(id: number, isFavorite: boolean) {
    const updated = await logsApi.updateLog(id, { isFavorite })
    await loadLogs()
    return updated
  }

  async function updateTags(id: number, tags: readonly string[]) {
    const updated = await logsApi.updateLog(id, { tags })
    await loadLogs()
    return updated
  }

  async function removeLog(id: number) {
    await logsApi.deleteLog(id)
    logs.value = logs.value.filter((log) => log.id !== id)
    total.value = Math.max(0, total.value - 1)
  }

  async function setTagFilter(tag: string) {
    await loadLogs({ page: 1, tag })
  }

  async function clearTagFilter() {
    await loadLogs({ page: 1, tag: null })
  }

  return {
    logs,
    page,
    pageSize,
    total,
    searchQuery,
    favoriteOnly,
    activeTagFilter,
    retentionDays,
    loading,
    settingsLoading,
    error,
    loadLogs,
    loadSettings,
    saveRetentionDays,
    renameLog,
    setFavorite,
    updateTags,
    removeLog,
    setTagFilter,
    clearTagFilter,
  }
})
