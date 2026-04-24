<template>
  <q-layout view="hHh lpR fFf">
    <q-header elevated class="bg-dark">
      <q-toolbar>
        <q-icon name="check_circle" :color="bunStatusColor" size="20px" class="q-mr-xs cursor-pointer" @click.stop="handleBunStatusClick">
          <q-tooltip>{{ bunStatusLabel }}</q-tooltip>
        </q-icon>
        <q-icon name="check_circle" :color="exeStatusColor" size="20px" class="q-mr-sm">
          <q-tooltip>{{ exeStatusLabel }}</q-tooltip>
        </q-icon>
        <q-toolbar-title shrink>{{ $t('app.title') }}</q-toolbar-title>
        <q-tabs
          :model-value="route.path"
          dense
          active-color="white"
          indicator-color="white"
          class="q-mx-sm"
        >
          <q-tab
            name="/settings"
            :label="$t('nav.settings')"
            @click="goTo('/settings')"
          />
          <q-tab
            name="/monitoring"
            :label="$t('nav.monitoring')"
            @click="goTo('/monitoring')"
          />
          <q-tab
            name="/audio"
            :label="$t('nav.audio')"
            @click="goTo('/audio')"
          />
          <q-tab
            name="/log"
            :label="$t('nav.log')"
            @click="goTo('/log')"
          />
          <q-tab
            name="/archive"
            :label="$t('nav.archive')"
            @click="goTo('/archive')"
          />
        </q-tabs>
        <q-space />
        <q-select
          v-model="locale"
          :options="localeOptions"
          dense
          borderless
          emit-value
          map-options
          options-dense
          dark
          style="min-width: 100px"
        />
      </q-toolbar>
    </q-header>

    <q-page-container>
      <router-view />
    </q-page-container>

    <q-dialog v-model="bunActionsDialog.isOpen" persistent class="main-layout__bun-actions-dialog">
      <q-card class="main-layout__bun-actions-card">
        <q-card-section class="main-layout__bun-actions-header">
          <div class="text-h6">{{ t('common.bunActionsTitle') }}</div>
          <div class="text-body2 text-grey-7">{{ t('common.bunActionsHint') }}</div>
        </q-card-section>

        <q-card-section class="main-layout__bun-actions-body">
          <div v-if="bunActionsDialog.loadingStatus" class="text-caption text-grey-6 q-mb-md">
            {{ t('common.bunActionsStatusLoading') }}
          </div>
          <div v-else-if="bunActionsDialog.statusError !== ''" class="text-caption text-negative q-mb-md">
            {{ bunActionsDialog.statusError }}
          </div>
          <div
            v-else-if="!bunActionsDialog.status.canRestartBun && bunActionsDialog.status.restartBunReason !== null"
            class="text-caption text-amber-9 q-mb-md"
          >
            {{ bunActionsDialog.status.restartBunReason }}
          </div>

          <q-checkbox
            v-model="bunActionsDialog.buildUi"
            :disable="bunActionsDialog.submitting || bunActionsDialog.loadingStatus"
            :label="t('common.bunActionBuildUi')"
          />
          <q-checkbox
            v-model="bunActionsDialog.restartBun"
            :disable="bunActionsDialog.submitting || bunActionsDialog.loadingStatus || bunActionsDialog.statusError !== '' || !bunActionsDialog.status.canRestartBun"
            :label="t('common.bunActionRestartBun')"
          />
          <q-checkbox
            v-model="bunActionsDialog.restartExe"
            :disable="bunActionsDialog.submitting || bunActionsDialog.loadingStatus"
            :label="t('common.bunActionRestartExe')"
          />

          <div v-if="showBunActionsProgress" class="q-mt-md">
            <div class="text-subtitle2 q-mb-sm">{{ t('common.bunActionsProgressTitle') }}</div>
            <q-linear-progress v-if="bunActionsDialog.submitting" indeterminate color="primary" class="q-mb-sm" />
            <div
              v-for="action in bunActionProgressRows"
              :key="action.key"
              class="row items-center justify-between q-py-xs"
            >
              <div class="row items-center q-gutter-sm">
                <q-icon :name="bunActionStateIcon(action.state)" :color="bunActionStateColor(action.state)" size="18px" />
                <span>{{ action.label }}</span>
              </div>
              <span class="text-caption text-grey-7">{{ bunActionStateLabel(action.state) }}</span>
            </div>

            <div v-if="bunActionsDialog.results.length > 0" class="q-mt-sm">
              <div
                v-for="result in bunActionsDialog.results"
                :key="result"
                class="text-caption text-grey-7 q-py-xs"
              >
                {{ result }}
              </div>
            </div>

            <div v-if="bunActionsDialog.actionError !== ''" class="text-caption text-negative q-mt-sm">
              {{ bunActionsDialog.actionError }}
            </div>
          </div>
        </q-card-section>

        <q-card-actions align="right" class="main-layout__bun-actions-footer">
          <q-btn flat :disable="bunActionsDialog.submitting" :label="t('common.closeAction')" @click="closeBunActionsDialog" />
          <q-btn
            color="primary"
            :disable="!canSubmitBunActions"
            :label="t('common.okAction')"
            :loading="bunActionsDialog.submitting"
            @click="submitBunActions"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-layout>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, watch } from 'vue'
import { useQuasar } from 'quasar'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { wsService } from 'src/services/ws'
import { adminApi, type AdminBunActionStatusResponse } from '../services/admin-api'
import { useSessionStore } from 'stores/session'

const { t, locale } = useI18n()
const $q = useQuasar()
const route = useRoute()
const router = useRouter()
const session = useSessionStore()

type BunActionKey = 'buildUi' | 'restartExe' | 'restartBun'
type BunActionProgressState = 'idle' | 'pending' | 'running' | 'completed' | 'failed' | 'scheduled' | 'skipped'
type BunActionReloadPhase = 'idle' | 'scheduled' | 'await-disconnect' | 'await-reconnect'

const BUN_ACTION_RELOAD_DELAY_MS = 400

const defaultBunActionStatus = (): AdminBunActionStatusResponse => ({
  canRestartBun: true,
  restartBunReason: null,
  isWatchMode: false,
})

const bunActionsDialog = reactive({
  isOpen: false,
  buildUi: false,
  restartBun: false,
  restartExe: false,
  submitting: false,
  loadingStatus: false,
  statusError: '',
  actionError: '',
  results: [] as string[],
  status: defaultBunActionStatus(),
  progress: {
    buildUi: 'idle' as BunActionProgressState,
    restartExe: 'idle' as BunActionProgressState,
    restartBun: 'idle' as BunActionProgressState,
  },
})

const bunActionReload = reactive({
  phase: 'idle' as BunActionReloadPhase,
})

const bunActionOrder: readonly BunActionKey[] = ['buildUi', 'restartExe', 'restartBun'] as const
let bunActionReloadTimer: ReturnType<typeof setTimeout> | null = null

const localeOptions = [
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Русский' }
]

watch(locale, (val) => {
  localStorage.setItem('mindwave-locale', val)
})

watch(() => session.connectStopRequestToken, (token) => {
  if (token <= 0) {
    return
  }

  wsService.send({ type: 'bodymonitor_stdio_stop' })
})

function goTo(path: '/settings' | '/monitoring' | '/audio' | '/log' | '/archive') {
  if (route.path === path) return
  void router.push(path)
}

function resetBunActionsSelection(): void {
  bunActionsDialog.buildUi = false
  bunActionsDialog.restartBun = false
  bunActionsDialog.restartExe = false
}

function resetBunActionsProgress(): void {
  bunActionsDialog.actionError = ''
  bunActionsDialog.results = []
  bunActionsDialog.progress.buildUi = 'idle'
  bunActionsDialog.progress.restartExe = 'idle'
  bunActionsDialog.progress.restartBun = 'idle'
}

function resetBunActionsDialog(): void {
  resetBunActionsSelection()
  resetBunActionsProgress()
  bunActionsDialog.loadingStatus = false
  bunActionsDialog.statusError = ''
  bunActionsDialog.status = defaultBunActionStatus()
}

function setBunActionProgress(action: BunActionKey, state: BunActionProgressState): void {
  bunActionsDialog.progress[action] = state
}

function clearBunActionReloadTimer(): void {
  if (bunActionReloadTimer === null) {
    return
  }

  clearTimeout(bunActionReloadTimer)
  bunActionReloadTimer = null
}

function resetBunActionReload(): void {
  clearBunActionReloadTimer()
  bunActionReload.phase = 'idle'
}

function reloadPageAfterBunActions(): void {
  resetBunActionReload()
  window.location.reload()
}

function scheduleBunActionReload(waitForReconnect: boolean): void {
  bunActionsDialog.isOpen = false

  if (waitForReconnect) {
    bunActionReload.phase = wsService.connectionState.value === 'connected'
      ? 'await-disconnect'
      : 'await-reconnect'
    return
  }

  resetBunActionReload()
  bunActionReload.phase = 'scheduled'
  bunActionReloadTimer = setTimeout(() => {
    reloadPageAfterBunActions()
  }, BUN_ACTION_RELOAD_DELAY_MS)
}

function getSelectedBunActions(): BunActionKey[] {
  const actions: BunActionKey[] = []

  if (bunActionsDialog.buildUi) {
    actions.push('buildUi')
  }

  if (bunActionsDialog.restartExe) {
    actions.push('restartExe')
  }

  if (bunActionsDialog.restartBun && bunActionsDialog.statusError === '' && bunActionsDialog.status.canRestartBun) {
    actions.push('restartBun')
  }

  return actions
}

async function loadBunActionStatus(): Promise<void> {
  bunActionsDialog.loadingStatus = true
  bunActionsDialog.statusError = ''

  try {
    bunActionsDialog.status = await adminApi.fetchBunActionStatus()
    if (!bunActionsDialog.status.canRestartBun) {
      bunActionsDialog.restartBun = false
    }
  } catch (error) {
    bunActionsDialog.statusError = error instanceof Error ? error.message : t('common.bunActionsStatusFailed')
  } finally {
    bunActionsDialog.loadingStatus = false
  }
}

function handleBunStatusClick(event: MouseEvent): void {
  if (!event.ctrlKey) {
    return
  }

  bunActionsDialog.isOpen = true
  resetBunActionsProgress()
  void loadBunActionStatus()
}

function closeBunActionsDialog(): void {
  if (bunActionsDialog.submitting) {
    return
  }

  bunActionsDialog.isOpen = false
}

async function submitBunActions(): Promise<void> {
  if (bunActionsDialog.submitting) {
    return
  }

  const selectedActions = getSelectedBunActions()
  if (selectedActions.length === 0) {
    return
  }

  resetBunActionsProgress()
  for (const action of selectedActions) {
    setBunActionProgress(action, 'pending')
  }

  bunActionsDialog.submitting = true

  try {
    for (const action of selectedActions) {
      setBunActionProgress(action, 'running')

      if (action === 'buildUi') {
        await adminApi.buildUi()
        setBunActionProgress(action, 'completed')
        bunActionsDialog.results.push(t('common.bunActionBuildUiCompleted'))
        continue
      }

      if (action === 'restartExe') {
        await adminApi.restartExe()
        setBunActionProgress(action, 'completed')
        bunActionsDialog.results.push(t('common.bunActionRestartExeCompleted'))
        continue
      }

      await adminApi.restartBun()
      setBunActionProgress(action, 'scheduled')
      bunActionsDialog.results.push(t('common.bunActionRestartBunScheduled'))
    }

    $q.notify({
      type: selectedActions.includes('restartBun') ? 'info' : 'positive',
      message: selectedActions.includes('restartBun') ? t('common.bunActionsRestartScheduled') : t('common.bunActionsApplied'),
      timeout: 2500,
    })

    scheduleBunActionReload(selectedActions.includes('restartBun'))
  } catch (error) {
    const activeAction = bunActionOrder.find((action) => bunActionsDialog.progress[action] === 'running')
    if (activeAction !== undefined) {
      setBunActionProgress(activeAction, 'failed')
      let markSkipped = false

      for (const action of selectedActions) {
        if (action === activeAction) {
          markSkipped = true
          continue
        }

        if (markSkipped && bunActionsDialog.progress[action] === 'pending') {
          setBunActionProgress(action, 'skipped')
        }
      }
    }

    bunActionsDialog.actionError = error instanceof Error ? error.message : t('common.bunActionsFailed')
    $q.notify({
      type: 'negative',
      message: bunActionsDialog.actionError,
    })
  } finally {
    bunActionsDialog.submitting = false

    if (!bunActionsDialog.isOpen) {
      resetBunActionsDialog()
    }
  }
}

const canSubmitBunActions = computed(() => {
  return !bunActionsDialog.loadingStatus && !bunActionsDialog.submitting && getSelectedBunActions().length > 0
})

const bunActionProgressRows = computed(() => {
  return bunActionOrder
    .map((action) => ({
      key: action,
      label: action === 'buildUi'
        ? t('common.bunActionBuildUi')
        : action === 'restartExe'
          ? t('common.bunActionRestartExe')
          : t('common.bunActionRestartBun'),
      state: bunActionsDialog.progress[action],
      active: getSelectedBunActions().includes(action) || bunActionsDialog.progress[action] !== 'idle',
    }))
    .filter((action) => action.active)
})

const showBunActionsProgress = computed(() => {
  return bunActionProgressRows.value.length > 0
})

function bunActionStateIcon(state: BunActionProgressState): string {
  switch (state) {
    case 'completed': return 'check_circle'
    case 'scheduled': return 'schedule'
    case 'failed': return 'error'
    case 'running': return 'sync'
    case 'pending': return 'hourglass_empty'
    case 'skipped': return 'redo'
    default: return 'radio_button_unchecked'
  }
}

function bunActionStateColor(state: BunActionProgressState): string {
  switch (state) {
    case 'completed': return 'positive'
    case 'scheduled': return 'info'
    case 'failed': return 'negative'
    case 'running': return 'primary'
    case 'pending': return 'warning'
    case 'skipped': return 'grey-6'
    default: return 'grey-5'
  }
}

function bunActionStateLabel(state: BunActionProgressState): string {
  switch (state) {
    case 'completed': return t('common.bunActionStateCompleted')
    case 'scheduled': return t('common.bunActionStateScheduled')
    case 'failed': return t('common.bunActionStateFailed')
    case 'running': return t('common.bunActionStateRunning')
    case 'pending': return t('common.bunActionStatePending')
    case 'skipped': return t('common.bunActionStateSkipped')
    default: return t('common.bunActionStateIdle')
  }
}

watch(() => bunActionsDialog.isOpen, (isOpen) => {
  if (isOpen) {
    return
  }

  if (!bunActionsDialog.submitting) {
    resetBunActionsDialog()
  }
})

watch(() => wsService.connectionState.value, (state) => {
  if (bunActionReload.phase === 'await-disconnect') {
    if (state !== 'connected') {
      bunActionReload.phase = 'await-reconnect'
    }
    return
  }

  if (bunActionReload.phase === 'await-reconnect' && state === 'connected') {
    reloadPageAfterBunActions()
  }
})

onBeforeUnmount(() => {
  resetBunActionReload()
})

const bunStatusColor = computed(() => {
  switch (wsService.connectionState.value) {
    case 'connected': return 'positive'
    default: return 'negative'
  }
})

const bunStatusLabel = computed(() => {
  switch (wsService.connectionState.value) {
    case 'connected': return t('common.bunConnected')
    case 'connecting': return t('common.bunConnecting')
    default: return t('common.bunDisconnected')
  }
})

const exeStatusColor = computed(() => {
  if (wsService.connectionState.value !== 'connected') {
    return 'negative'
  }

  switch (session.exeState) {
    case 'running': return 'positive'
    case 'starting':
    case 'stopping':
      return 'warning'
    default:
      return 'negative'
  }
})

const exeStatusLabel = computed(() => {
  if (wsService.connectionState.value !== 'connected') {
    return t('common.exeIdle')
  }

  switch (session.exeState) {
    case 'running': return t('common.exeRunning')
    case 'starting': return t('common.exeStarting')
    case 'stopping': return t('common.exeStopping')
    default: return t('common.exeIdle')
  }
})
</script>

<style scoped>
.main-layout__bun-actions-card {
  border-radius: 0;
  max-width: 92vw;
  min-width: 360px;
  overflow: hidden;
}

.main-layout__bun-actions-header {
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  padding: 16px;
}

.main-layout__bun-actions-body {
  padding: 16px;
}

.main-layout__bun-actions-footer {
  border-top: 1px solid rgba(148, 163, 184, 0.18);
  padding: 12px 16px;
}

@media (max-width: 480px) {
  .main-layout__bun-actions-card {
    min-width: min(100vw - 16px, 360px);
  }
}
</style>

