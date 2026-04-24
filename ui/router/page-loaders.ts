export const loadMainLayout = () => import('../layouts/MainLayout.vue')

export const loadSettingsPage = () => import('../pages/SettingsPage.vue')

export const loadMonitoringPage = () =>
  import('../../../BodyMonitorCore/ui').then((module) => module.MonitoringPage)

export const loadAudioPage = () =>
  import('../../../GnauralCore/ui').then((module) => module.AudioPage)

export const loadLogPage = () => import('../pages/LogPage.vue')

export const loadLogArchivePage = () => import('../pages/LogArchivePage.vue')
