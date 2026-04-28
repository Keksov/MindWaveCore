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
          <q-tab
            v-for="tab in settingsTabs"
            :key="tab.name"
            :name="tab.name"
            :icon="tab.icon"
            :label="$t(tab.labelKey)"
          />
        </q-tabs>

        <q-separator />

        <q-tab-panels v-model="activeTab" animated class="settings-page__panels">
          <q-tab-panel
            v-for="tab in settingsTabs"
            :key="tab.name"
            :name="tab.name"
            class="settings-page__panel"
          >
            <Suspense>
              <component :is="tab.component" />
              <template #fallback>
                <div class="settings-page__loading">
                  <q-spinner-hourglass color="primary" size="28px" />
                </div>
              </template>
            </Suspense>
          </q-tab-panel>
        </q-tab-panels>
      </q-card>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { settingsTabs } from '../src/modules'

const activeTab = ref(settingsTabs[0]?.name ?? '')

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

.settings-page__loading {
  align-items: center;
  display: flex;
  justify-content: center;
  min-height: 180px;
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
