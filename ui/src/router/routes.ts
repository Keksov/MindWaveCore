import type { RouteRecordRaw } from 'vue-router'
import {
  loadAudioPage,
  loadLogArchivePage,
  loadLogPage,
  loadMainLayout,
  loadMonitoringPage,
  loadSettingsPage,
} from '../../router/page-loaders'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: loadMainLayout,
    children: [
      { path: '', redirect: '/settings' },
      { path: 'settings', component: loadSettingsPage },
      { path: 'monitoring', component: loadMonitoringPage },
      { path: 'audio', component: loadAudioPage },
      { path: 'log', component: loadLogPage },
      { path: 'archive', component: loadLogArchivePage }
    ]
  }
]

export default routes
