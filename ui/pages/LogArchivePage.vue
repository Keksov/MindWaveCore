<template>
  <q-page class="archive-page">
    <div class="archive-page__inner">
      <div class="archive-page__header row items-start q-col-gutter-lg">
        <div class="col-12 col-md">
          <div class="text-h5">{{ $t('archive.title') }}</div>
          <div class="text-caption text-grey-5 q-mt-xs">{{ $t('archive.subtitle') }}</div>
        </div>

        <div class="col-12 col-md-auto">
          <div class="row q-col-gutter-sm items-end archive-page__settings">
            <div class="col-auto">
              <q-input
                v-model.number="retentionInput"
                type="number"
                dense
                outlined
                debounce="600"
                min="0"
                :loading="archive.settingsLoading"
                :label="$t('archive.retentionDays')"
                :hint="$t('archive.retentionDisabledHint')"
                persistent-hint
                @update:model-value="onRetentionChanged"
                @blur="onRetentionBlur"
              />
            </div>
          </div>
        </div>
      </div>

      <q-banner v-if="replay.isReplayMode" class="archive-page__banner bg-amber-5 text-dark rounded-borders">
        <div class="row items-center justify-between q-gutter-sm">
          <div>
            <div class="text-subtitle2">{{ $t('archive.replayBadge') }}</div>
            <div class="text-caption">{{ $t('archive.replayActiveBanner', { name: replay.replaySessionName }) }}</div>
          </div>
          <q-btn flat dense icon="close" :label="$t('archive.stopReplay')" @click="unloadArchivedData" />
        </div>
      </q-banner>

      <q-card flat bordered class="archive-page__card">
        <div class="row q-col-gutter-md q-pa-md items-center archive-page__controls">
          <div class="col-12 col-md">
            <q-input
              v-model="searchText"
              dense
              outlined
              clearable
              debounce="250"
              :label="$t('archive.searchLabel')"
              @update:model-value="onSearchChanged"
            >
              <template #prepend>
                <q-icon name="search" />
              </template>
            </q-input>
          </div>

          <div class="col-12 col-sm-auto">
            <q-toggle
              :model-value="archive.favoriteOnly"
              color="amber"
              :label="$t('archive.favoriteOnly')"
              @update:model-value="onFavoriteToggle"
            />
          </div>

          <div class="col-12 col-sm-auto">
            <q-btn flat icon="refresh" :label="$t('archive.refresh')" :loading="archive.loading" @click="reload" />
          </div>

          <div v-if="selectedLogIds.length > 0" class="col-12 col-sm-auto">
            <q-btn
              color="negative"
              icon="delete"
              :label="$t('archive.deleteSelectedAction', { count: selectedLogIds.length })"
              @click="requestRemoveSelectedLogs"
            />
          </div>
        </div>

        <div v-if="archive.activeTagFilter !== ''" class="q-px-md q-pb-md">
          <q-chip color="secondary" text-color="white" removable @remove="clearTagFilter">
            {{ $t('archive.filterByTag', { tag: archive.activeTagFilter }) }}
          </q-chip>
        </div>

        <q-table
          flat
          :rows="archive.logs"
          :columns="columns"
          row-key="id"
          :loading="archive.loading"
          hide-pagination
        >
          <template #header-cell-select="props">
            <q-th :props="props" class="archive-page__select-column text-center">
              <q-checkbox
                :model-value="allSelectableLogsSelected"
                :indeterminate="partiallySelectedLogs"
                :disable="selectableLogIds.length === 0"
                @update:model-value="toggleSelectAllLogs"
              />
            </q-th>
          </template>

          <template #body-cell-select="props">
            <q-td :props="props" class="archive-page__select-column text-center">
              <q-checkbox
                :model-value="isLogSelected(props.row.id)"
                :disable="isDeleteDisabled(props.row)"
                @update:model-value="(value) => toggleLogSelection(props.row.id, value)"
              />
            </q-td>
          </template>

          <template #body-cell-createdAt="props">
            <q-td :props="props">
              {{ formatDateTime(props.row.createdAt) }}
            </q-td>
          </template>

          <template #body-cell-name="props">
            <q-td :props="props">
              <q-input
                dense
                borderless
                class="archive-page__name-input"
                :model-value="draftName(props.row.id, props.row.customName)"
                :placeholder="props.row.defaultName"
                @update:model-value="(value) => setDraftName(props.row.id, value)"
                @blur="saveName(props.row.id, props.row.customName)"
                @keyup.enter="saveName(props.row.id, props.row.customName)"
              >
                <template #prepend>
                  <q-icon v-if="props.row.isFavorite" name="star" color="amber-5" size="xs" />
                </template>
              </q-input>
            </q-td>
          </template>

          <template #body-cell-tags="props">
            <q-td :props="props" class="archive-page__tags-cell">
              <q-input
                v-if="editingTagsId === props.row.id"
                dense
                outlined
                autofocus
                class="archive-page__tags-input"
                :model-value="draftTagsValue(props.row.id, props.row.tags)"
                :placeholder="$t('archive.tagsPlaceholder')"
                @update:model-value="(value) => setDraftTags(props.row.id, value)"
                @blur="saveTags(props.row.id, props.row.tags)"
                @keyup.enter="saveTags(props.row.id, props.row.tags)"
                @keyup.esc="cancelTagsEdit(props.row.id, props.row.tags)"
              />

              <div
                v-else
                class="archive-page__tags-display"
                :title="$t('archive.tagsEditHint')"
                @click="startTagsEdit(props.row.id, props.row.tags)"
              >
                <div v-if="props.row.tags.length > 0" class="archive-page__tags-inline">
                  <template v-for="(tag, index) in props.row.tags" :key="tag">
                    <span
                      class="archive-page__tag-link"
                      :class="{ 'archive-page__tag-link--active': archive.activeTagFilter === tag }"
                      @click.stop="applyTagFilter(tag)"
                    >
                      {{ tag }}
                    </span>
                    <span v-if="index < props.row.tags.length - 1" class="archive-page__tag-separator">, </span>
                  </template>
                </div>
                <div v-else class="archive-page__tags-empty">
                  {{ $t('archive.tagsEmptyHint') }}
                </div>

                <q-icon name="edit" size="xs" color="grey-5" class="archive-page__tags-edit-icon" />
              </div>
            </q-td>
          </template>

          <template #body-cell-deviceSummary="props">
            <q-td :props="props" class="archive-page__devices-cell">
              <div v-if="props.row.deviceSummary.length === 0" class="text-grey-5">
                {{ $t('archive.noDevices') }}
              </div>
              <div v-else class="archive-page__devices-list">
                <div
                  v-for="deviceSummary in props.row.deviceSummary"
                  :key="deviceSummaryKey(deviceSummary)"
                  class="archive-page__device-item"
                >
                  <q-icon
                    :name="capabilityAppearance(deviceSummary.capability).icon"
                    :color="capabilityAppearance(deviceSummary.capability).color"
                    size="xs"
                  />
                  <span class="archive-page__device-capability">
                    {{ capabilityLabel(deviceSummary.capability) }}
                  </span>
                  <span class="archive-page__device-separator">·</span>
                  <span class="archive-page__device-label">{{ deviceSummary.label }}</span>
                </div>
              </div>
            </q-td>
          </template>

          <template #body-cell-status="props">
            <q-td :props="props">
              <q-badge :label="statusLabel(props.row.status)" :color="statusColor(props.row.status)" />
            </q-td>
          </template>

          <template #body-cell-favorite="props">
            <q-td :props="props" class="text-center">
              <q-btn
                flat
                round
                :icon="props.row.isFavorite ? 'star' : 'star_outline'"
                :color="props.row.isFavorite ? 'amber-5' : 'grey-5'"
                @click="toggleFavorite(props.row.id, props.row.isFavorite)"
              />
            </q-td>
          </template>

          <template #body-cell-actions="props">
            <q-td :props="props" class="archive-page__actions-cell">
              <div class="archive-page__actions-row">
                <q-btn flat dense icon="download" color="secondary" :label="$t('archive.replayAction')" @click="loadArchivedLog(props.row)" />
                <div class="archive-page__delete-action" :title="isDeleteDisabled(props.row) ? $t('archive.deleteActiveHint') : ''">
                  <q-btn
                    flat
                    dense
                    icon="delete"
                    color="negative"
                    :label="$t('archive.deleteAction')"
                    :disable="isDeleteDisabled(props.row)"
                    @click="requestRemoveLog(props.row)"
                  />
                </div>
              </div>
            </q-td>
          </template>

          <template #no-data>
            <div class="full-width q-pa-lg text-center text-grey-5">
              {{ archive.loading ? $t('archive.loading') : $t('archive.empty') }}
            </div>
          </template>
        </q-table>

        <div class="row items-center justify-between q-pa-md archive-page__footer">
          <div class="row items-center q-gutter-sm">
            <span class="text-caption text-grey-5">{{ $t('archive.rowsPerPage') }}</span>
            <q-select
              dense
              outlined
              emit-value
              map-options
              options-dense
              :model-value="archive.pageSize"
              :options="pageSizeOptions"
              @update:model-value="onPageSizeChanged"
            />
          </div>

          <q-pagination
            :model-value="archive.page"
            :max="pageCount"
            direction-links
            boundary-links
            @update:model-value="onPageChanged"
          />
        </div>
      </q-card>

      <q-dialog v-model="deleteDialog.isOpen" persistent>
        <q-card class="archive-page__delete-dialog">
          <q-card-section>
            <div class="text-h6">{{ $t('archive.deleteDialogTitle') }}</div>
          </q-card-section>

          <q-card-section class="q-pt-none">
            {{ deleteDialogMessage }}
          </q-card-section>

          <q-card-actions align="right">
            <q-btn flat :label="$t('archive.cancelAction')" @click="closeDeleteDialog" />
            <q-btn
              color="negative"
              :label="$t('archive.deleteAction')"
              :loading="deleteDialog.isSubmitting"
              @click="confirmDelete"
            />
          </q-card-actions>
        </q-card>
      </q-dialog>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useQuasar } from 'quasar'
import type { ArchivedLogSummary, LogDeviceSummary, LogSessionStatus } from '@protocol'
import { capabilityMeta } from 'stores/device'
import { useLogArchiveStore } from 'stores/log-archive'
import { useReplayStore } from 'stores/replay'

const { t } = useI18n()
const $q = useQuasar()
const router = useRouter()
const archive = useLogArchiveStore()
const replay = useReplayStore()

const searchText = ref('')
const retentionInput = ref(archive.retentionDays)
const draftNames = ref<Record<number, string>>({})
const draftTags = ref<Record<number, string>>({})
const editingTagsId = ref<number | null>(null)
const selectedLogIds = ref<number[]>([])
const lastSubmittedRetention = ref<number | null>(null)

function createDeleteDialogState() {
  return {
    isOpen: false,
    isSubmitting: false,
    logIds: [] as number[],
    errorMessage: '',
    successMode: 'single' as 'single' | 'multiple',
    emptyPageFallback: false,
  }
}

const deleteDialog = ref(createDeleteDialogState())

let retentionSaveRequestId = 0

const fallbackCapabilityMeta = { icon: 'device_unknown', color: 'grey' }

const pageSizeOptions = [
  { label: '10', value: 10 },
  { label: '25', value: 25 },
  { label: '50', value: 50 },
]

const pageCount = computed(() => {
  return Math.max(1, Math.ceil(archive.total / archive.pageSize))
})

const columns = computed(() => [
  { name: 'select', label: '', field: 'id', align: 'center' as const },
  { name: 'createdAt', label: t('archive.createdAt'), field: 'createdAt', align: 'left' as const },
  { name: 'name', label: t('archive.name'), field: 'effectiveName', align: 'left' as const },
  { name: 'tags', label: t('archive.tags'), field: 'tags', align: 'left' as const },
  { name: 'deviceSummary', label: t('archive.devices'), field: 'deviceSummary', align: 'left' as const },
  { name: 'eventCount', label: t('archive.eventCount'), field: 'eventCount', align: 'right' as const },
  { name: 'status', label: t('archive.status'), field: 'status', align: 'left' as const },
  { name: 'favorite', label: t('archive.favorite'), field: 'isFavorite', align: 'center' as const },
  { name: 'actions', label: t('archive.actions'), field: 'id', align: 'right' as const },
])

const selectableLogIds = computed(() => {
  return archive.logs.filter((log) => !isDeleteDisabled(log)).map((log) => log.id)
})

const allSelectableLogsSelected = computed(() => {
  return selectableLogIds.value.length > 0 && selectableLogIds.value.every((id) => selectedLogIds.value.includes(id))
})

const partiallySelectedLogs = computed(() => {
  return selectedLogIds.value.length > 0 && !allSelectableLogsSelected.value
})

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString()
}

function capabilityAppearance(capability: string) {
  return capabilityMeta[capability] ?? fallbackCapabilityMeta
}

function capabilityLabel(capability: string): string {
  const key = `capability.${capability}`
  const translated = t(key)
  return translated === key ? capability : translated
}

function deviceSummaryKey(deviceSummary: LogDeviceSummary): string {
  return `${deviceSummary.capability}:${deviceSummary.label}`
}

function isLogSelected(id: number): boolean {
  return selectedLogIds.value.includes(id)
}

function toggleLogSelection(id: number, value: boolean | null) {
  if (value === true) {
    if (!selectedLogIds.value.includes(id)) {
      selectedLogIds.value = [...selectedLogIds.value, id]
    }
    return
  }

  selectedLogIds.value = selectedLogIds.value.filter((selectedId) => selectedId !== id)
}

function toggleSelectAllLogs(value: boolean | null) {
  selectedLogIds.value = value === true ? [...selectableLogIds.value] : []
}

function clearSelectedLogs() {
  selectedLogIds.value = []
}

function openDeleteDialog(options: {
  logIds: number[]
  errorMessage: string
  successMode: 'single' | 'multiple'
  emptyPageFallback: boolean
}) {
  deleteDialog.value = {
    ...createDeleteDialogState(),
    isOpen: true,
    logIds: options.logIds,
    errorMessage: options.errorMessage,
    successMode: options.successMode,
    emptyPageFallback: options.emptyPageFallback,
  }
}

function closeDeleteDialog() {
  if (deleteDialog.value.isSubmitting) {
    return
  }

  deleteDialog.value = createDeleteDialogState()
}

const deleteDialogMessage = computed(() => {
  const count = deleteDialog.value.logIds.length
  return deleteDialog.value.successMode === 'multiple'
    ? t('archive.deleteSelectedConfirm', { count })
    : t('archive.deleteConfirm')
})

function statusLabel(status: LogSessionStatus): string {
  switch (status) {
    case 'active': return t('archive.statusActive')
    case 'completed': return t('archive.statusCompleted')
    case 'failed': return t('archive.statusFailed')
    case 'interrupted': return t('archive.statusInterrupted')
  }
}

function statusColor(status: LogSessionStatus): string {
  switch (status) {
    case 'active': return 'warning'
    case 'completed': return 'positive'
    case 'failed': return 'negative'
    case 'interrupted': return 'grey-6'
  }
}

function draftName(id: number, currentCustomName?: string): string {
  return draftNames.value[id] ?? currentCustomName ?? ''
}

function setDraftName(id: number, value: string | number | null) {
  draftNames.value = {
    ...draftNames.value,
    [id]: typeof value === 'string' ? value : value == null ? '' : String(value),
  }
}

function formatTags(tags: readonly string[]): string {
  return tags.join(', ')
}

function normalizeTagInput(value: string | number | null): string[] {
  const rawValue = typeof value === 'string' ? value : value == null ? '' : String(value)
  const seen = new Set<string>()
  const result: string[] = []

  for (const part of rawValue.split(',')) {
    const normalized = part.trim().toLowerCase()
    if (normalized === '' || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

function draftTagsValue(id: number, currentTags: readonly string[]): string {
  return draftTags.value[id] ?? formatTags(currentTags)
}

function setDraftTags(id: number, value: string | number | null) {
  draftTags.value = {
    ...draftTags.value,
    [id]: typeof value === 'string' ? value : value == null ? '' : String(value),
  }
}

function startTagsEdit(id: number, currentTags: readonly string[]) {
  draftTags.value = {
    ...draftTags.value,
    [id]: draftTags.value[id] ?? formatTags(currentTags),
  }
  editingTagsId.value = id
}

function cancelTagsEdit(id: number, currentTags: readonly string[]) {
  draftTags.value = {
    ...draftTags.value,
    [id]: formatTags(currentTags),
  }
  if (editingTagsId.value === id) {
    editingTagsId.value = null
  }
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  return left.every((tag, index) => tag === right[index])
}

async function saveName(id: number, currentCustomName?: string) {
  const nextValue = (draftNames.value[id] ?? currentCustomName ?? '').trim()
  const currentValue = (currentCustomName ?? '').trim()

  if (nextValue === currentValue) {
    return
  }

  try {
    await archive.renameLog(id, nextValue === '' ? null : nextValue)
    draftNames.value = {
      ...draftNames.value,
      [id]: nextValue,
    }
  } catch (error) {
    $q.notify({ type: 'negative', message: error instanceof Error ? error.message : t('archive.renameFailed') })
  }
}

async function saveTags(id: number, currentTags: readonly string[]) {
  const nextTags = normalizeTagInput(draftTags.value[id] ?? formatTags(currentTags))
  editingTagsId.value = null

  if (sameTags(nextTags, currentTags)) {
    draftTags.value = {
      ...draftTags.value,
      [id]: formatTags(currentTags),
    }
    return
  }

  try {
    await archive.updateTags(id, nextTags)
    draftTags.value = {
      ...draftTags.value,
      [id]: formatTags(nextTags),
    }
  } catch (error) {
    draftTags.value = {
      ...draftTags.value,
      [id]: formatTags(currentTags),
    }
    $q.notify({ type: 'negative', message: error instanceof Error ? error.message : t('archive.tagsUpdateFailed') })
  }
}

async function toggleFavorite(id: number, currentValue: boolean) {
  try {
    await archive.setFavorite(id, !currentValue)
  } catch (error) {
    $q.notify({ type: 'negative', message: error instanceof Error ? error.message : t('archive.favoriteFailed') })
  }
}

function applyTagFilter(tag: string) {
  if (archive.activeTagFilter === tag) {
    void archive.clearTagFilter()
    return
  }

  void archive.setTagFilter(tag)
}

function clearTagFilter() {
  void archive.clearTagFilter()
}

function isDeleteDisabled(log: ArchivedLogSummary): boolean {
  return log.status === 'active'
}

function requestRemoveLog(log: ArchivedLogSummary) {
  if (isDeleteDisabled(log)) {
    return
  }

  openDeleteDialog({
    logIds: [log.id],
    errorMessage: t('archive.deleteFailed'),
    successMode: 'single',
    emptyPageFallback: true,
  })
}

function requestRemoveSelectedLogs() {
  if (selectedLogIds.value.length === 0) {
    return
  }

  openDeleteDialog({
    logIds: [...selectedLogIds.value],
    errorMessage: t('archive.deleteSelectedFailed'),
    successMode: 'multiple',
    emptyPageFallback: true,
  })
}

async function confirmDelete() {
  if (deleteDialog.value.logIds.length === 0 || deleteDialog.value.isSubmitting) {
    return
  }

  deleteDialog.value = {
    ...deleteDialog.value,
    isSubmitting: true,
  }

  const { logIds, errorMessage, emptyPageFallback } = deleteDialog.value

  try {
    for (const id of logIds) {
      await archive.removeLog(id)
    }

    selectedLogIds.value = selectedLogIds.value.filter((id) => !logIds.includes(id))
    deleteDialog.value = createDeleteDialogState()

    if (emptyPageFallback && archive.logs.length === 0 && archive.page > 1) {
      await archive.loadLogs({ page: archive.page - 1 })
      return
    }

    await archive.loadLogs()
  } catch (error) {
    $q.notify({ type: 'negative', message: error instanceof Error ? error.message : errorMessage })
  } finally {
    deleteDialog.value = {
      ...deleteDialog.value,
      isSubmitting: false,
    }
  }
}

function loadArchivedLog(log: ArchivedLogSummary) {
  const sent = replay.startReplay(log.id)
  if (!sent) {
    $q.notify({ type: 'negative', message: t('archive.replaySendFailed') })
    return
  }

  void router.push('/monitoring')
}

function unloadArchivedData() {
  replay.stopReplay()
}

function normalizeRetentionDays(value: string | number | null): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null
  }

  if (typeof value === 'string') {
    const trimmedValue = value.trim()
    if (trimmedValue === '') {
      return null
    }

    const numericValue = Number(trimmedValue)
    return Number.isFinite(numericValue) ? Math.max(0, Math.trunc(numericValue)) : null
  }

  return null
}

async function persistRetentionDays(value: number) {
  const requestId = ++retentionSaveRequestId
  lastSubmittedRetention.value = value

  try {
    await archive.saveRetentionDays(value)

    if (requestId === retentionSaveRequestId) {
      retentionInput.value = archive.retentionDays
    }
  } catch (error) {
    if (requestId === retentionSaveRequestId) {
      retentionInput.value = archive.retentionDays
      $q.notify({ type: 'negative', message: error instanceof Error ? error.message : t('archive.retentionFailed') })
    }
  } finally {
    if (requestId === retentionSaveRequestId) {
      lastSubmittedRetention.value = null
    }
  }
}

function onRetentionChanged(value: string | number | null) {
  const nextValue = normalizeRetentionDays(value)
  if (nextValue === null) {
    return
  }

  retentionInput.value = nextValue

  if (nextValue === archive.retentionDays || nextValue === lastSubmittedRetention.value) {
    return
  }

  void persistRetentionDays(nextValue)
}

function onRetentionBlur() {
  const nextValue = normalizeRetentionDays(retentionInput.value)

  if (nextValue === null) {
    retentionInput.value = archive.retentionDays
    return
  }

  retentionInput.value = nextValue

  if (nextValue === archive.retentionDays || nextValue === lastSubmittedRetention.value) {
    return
  }

  void persistRetentionDays(nextValue)
}

function onSearchChanged(value: string | number | null) {
  const nextValue = typeof value === 'string' ? value : value == null ? '' : String(value)
  void archive.loadLogs({ page: 1, q: nextValue })
}

function onFavoriteToggle(value: boolean | null) {
  void archive.loadLogs({ page: 1, favoriteOnly: value === true })
}

function onPageChanged(nextPage: number) {
  void archive.loadLogs({ page: nextPage })
}

function onPageSizeChanged(nextPageSize: number | null) {
  const pageSize = typeof nextPageSize === 'number' ? nextPageSize : 25
  void archive.loadLogs({ page: 1, pageSize })
}

function reload() {
  void archive.loadLogs()
}

watch(
  () => archive.logs.map((log) => log.id),
  (visibleIds) => {
    const visibleIdSet = new Set(visibleIds)
    selectedLogIds.value = selectedLogIds.value.filter((id) => visibleIdSet.has(id))
  },
)

onMounted(() => {
  searchText.value = archive.searchQuery
  retentionInput.value = archive.retentionDays
  void archive.loadSettings().then(() => {
    retentionInput.value = archive.retentionDays
  })
  void archive.loadLogs()
})
</script>

<style scoped>
.archive-page {
  min-height: 0;
}

.archive-page__inner {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100%;
  padding: 16px;
}

.archive-page__banner {
  border: 1px solid rgba(217, 119, 6, 0.18);
}

.archive-page__select-column {
  width: 52px;
}

.archive-page__devices-cell {
  max-width: 280px;
  white-space: normal;
}

.archive-page__devices-list,
.archive-page__tags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.archive-page__device-item {
  align-items: center;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 999px;
  display: inline-flex;
  gap: 6px;
  max-width: 100%;
  padding: 4px 10px;
}

.archive-page__device-capability {
  color: rgba(241, 245, 249, 0.94);
  font-size: 0.75rem;
  font-weight: 600;
}

.archive-page__device-separator,
.archive-page__device-label {
  color: rgba(203, 213, 225, 0.84);
  font-size: 0.75rem;
}

.archive-page__device-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archive-page__tags-cell {
  min-width: 220px;
}

.archive-page__tags-input {
  min-width: 220px;
}

.archive-page__tags-display {
  align-items: center;
  border: 1px dashed rgba(148, 163, 184, 0.2);
  border-radius: 8px;
  cursor: text;
  display: flex;
  gap: 8px;
  min-height: 36px;
  min-width: 220px;
  padding: 6px 10px;
}

.archive-page__tags-display:hover {
  border-color: rgba(148, 163, 184, 0.35);
  background: rgba(255, 255, 255, 0.03);
}

.archive-page__tags-inline {
  color: rgba(241, 245, 249, 0.92);
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archive-page__tag-link {
  color: rgba(125, 211, 252, 0.95);
  cursor: pointer;
  text-decoration: underline dotted;
}

.archive-page__tag-link--active {
  color: rgba(255, 255, 255, 0.98);
  font-weight: 600;
  text-decoration-style: solid;
}

.archive-page__tag-separator {
  color: rgba(148, 163, 184, 0.78);
}

.archive-page__tags-empty {
  color: rgba(148, 163, 184, 0.88);
  flex: 1 1 auto;
  min-width: 0;
}

.archive-page__tags-edit-icon {
  flex: 0 0 auto;
}

.archive-page__actions-cell {
  white-space: nowrap;
}

.archive-page__actions-row {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.archive-page__delete-action {
  display: inline-flex;
}

.archive-page__footer {
  border-top: 1px solid rgba(148, 163, 184, 0.12);
}

.archive-page__name-input {
  min-width: 220px;
}

@media (max-width: 768px) {
  .archive-page__inner {
    padding: 12px;
  }

  .archive-page__actions-cell {
    white-space: normal;
  }

  .archive-page__actions-row {
    flex-direction: column;
    align-items: stretch;
  }

  .archive-page__delete-action {
    display: flex;
  }
}
</style>