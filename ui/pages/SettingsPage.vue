<template>
  <q-page class="settings-page" :style-fn="pageStyle">
    <div class="settings-page__inner">
      <q-card flat bordered class="settings-page__card">
        <q-tabs
          v-model="activeTab"
          align="left"
          active-color="primary"
          indicator-color="primary"
          inline-label
          no-caps
        >
          <q-tab name="devices" icon="memory" :label="$t('settings.devicesTab')" />
          <q-tab name="audio" icon="graphic_eq" :label="$t('settings.audioTab')" />
        </q-tabs>

        <q-separator />

        <q-tab-panels v-model="activeTab" animated class="settings-page__panels">
          <q-tab-panel name="devices" class="settings-page__panel">
            <div class="settings-page__devices-layout">
              <div class="settings-page__content">
                <device-list />
              </div>
              <div class="settings-page__scan-block">
                <device-scan-block />
              </div>
            </div>
          </q-tab-panel>

          <q-tab-panel name="audio" class="settings-page__panel">
            <q-card flat bordered class="settings-page__audio-card">
              <q-card-section>
                <div class="text-h6">{{ $t('settings.audioTitle') }}</div>
                <div class="text-caption text-grey-7">{{ $t('settings.audioSubtitle') }}</div>
              </q-card-section>

              <q-separator />

              <q-card-section class="settings-page__audio-form">
                <q-input
                  v-model="presetsRootDraft"
                  :label="$t('settings.audioPresetsRoot')"
                  dense
                  outlined
                  spellcheck="false"
                />
                <div class="settings-page__audio-actions">
                  <q-btn color="primary" :label="$t('settings.audioSave')" :loading="audio.settingsLoading" @click="saveAudioSettings" />
                  <q-btn flat color="primary" icon="refresh" :label="$t('settings.audioRefreshPresets')" :loading="audio.presetsLoading" @click="refreshAudioPresets" />
                </div>
                <q-banner v-if="audioMessage !== null" dense rounded :class="audioMessageClass">
                  {{ audioMessage }}
                </q-banner>
                <div class="text-caption text-grey-7">
                  {{ $t('settings.audioPresetsRootHint') }}
                </div>
              </q-card-section>
            </q-card>
          </q-tab-panel>
        </q-tab-panels>
      </q-card>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import DeviceScanBlock from 'components/DeviceScanBlock.vue'
import DeviceList from 'components/DeviceList.vue'
import { useAudioStore } from 'stores/audio'

const audio = useAudioStore()
const activeTab = ref<'devices' | 'audio'>('devices')
const presetsRootDraft = ref('')
const audioMessage = ref<string | null>(null)
const audioMessageClass = ref('bg-grey-2 text-grey-9')
let audioMessageTimer: ReturnType<typeof setTimeout> | null = null

function clearAudioMessageTimer(): void {
  if (audioMessageTimer !== null) {
    clearTimeout(audioMessageTimer)
    audioMessageTimer = null
  }
}

function setAudioMessage(message: string | null, cssClass: string, autoClear = false): void {
  clearAudioMessageTimer()
  audioMessage.value = message
  audioMessageClass.value = cssClass

  if (autoClear && message !== null) {
    audioMessageTimer = setTimeout(() => {
      audioMessage.value = null
      audioMessageTimer = null
    }, 4000)
  }
}

async function saveAudioSettings() {
  const saved = await audio.saveSettings(presetsRootDraft.value)
  if (!saved) {
    setAudioMessage(audio.lastError, 'bg-red-1 text-red-10')
    return
  }

  presetsRootDraft.value = audio.settings.presetsRoot
  await audio.refreshPresets()

  if (audio.lastError !== null) {
    setAudioMessage(audio.lastError, 'bg-red-1 text-red-10')
    return
  }

  setAudioMessage('OK', 'bg-green-1 text-green-10', true)
}

async function refreshAudioPresets() {
  await audio.refreshPresets()
  if (audio.lastError !== null) {
    setAudioMessage(audio.lastError, 'bg-red-1 text-red-10')
    return
  }

  setAudioMessage('OK', 'bg-green-1 text-green-10', true)
}

onMounted(async () => {
  await audio.loadSettings()
  presetsRootDraft.value = audio.settings.presetsRoot

  if (audio.lastError !== null) {
    setAudioMessage(audio.lastError, 'bg-red-1 text-red-10')
  }
})

onBeforeUnmount(() => {
  clearAudioMessageTimer()
})

function pageStyle(offset: number, height: number) {
  const pageHeight = Math.max(0, height - offset)

  return {
    height: `${pageHeight}px`,
    minHeight: `${pageHeight}px`,
  }
}
</script>

<style scoped>
.settings-page {
  min-height: 0;
  overflow: hidden;
}

.settings-page__inner {
  box-sizing: border-box;
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  padding: 16px;
}

.settings-page__card {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}

.settings-page__panels {
  flex: 1 1 auto;
  min-height: 0;
}

.settings-page__panel {
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 16px;
}

.settings-page__devices-layout {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  min-height: 0;
}

.settings-page__audio-card {
  max-width: 720px;
}

.settings-page__audio-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.settings-page__audio-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.settings-page__content {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.settings-page__scan-block {
  background: rgba(15, 23, 42, 0.55);
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 14px;
  padding: 14px;
}

@media (max-width: 768px) {
  .settings-page__inner {
    padding: 12px;
  }

  .settings-page__panel {
    padding: 12px;
  }

  .settings-page__devices-layout {
    gap: 12px;
  }
}
</style>
