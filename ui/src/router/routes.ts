import type { RouteRecordRaw } from 'vue-router'
import {
  loadLogArchivePage,
  loadLogPage,
  loadMainLayout,
  loadPanelHostPage,
  loadSettingsPage,
} from '../../router/page-loaders'
import { moduleRoutes } from '../modules'

const moduleRouteRecords: RouteRecordRaw[] = moduleRoutes.map((route) => ({
  name: route.name,
  path: route.path,
  component: route.component,
}))

const routes: RouteRecordRaw[] = [
  // PW2.1 (PW-D4): a detached child window's content — OUTSIDE MainLayout (no nav/header).
  {
    path: '/panel/:panelId',
    component: loadPanelHostPage,
  },
  {
    path: '/',
    component: loadMainLayout,
    children: [
      { path: '', redirect: '/settings' },
      { path: 'settings', component: loadSettingsPage },
      ...moduleRouteRecords,
      { path: 'log', component: loadLogPage },
      { path: 'archive', component: loadLogArchivePage }
    ]
  }
]

export default routes
