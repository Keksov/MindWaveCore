import type { RouteRecordRaw } from 'vue-router'
import {
  loadLogArchivePage,
  loadLogPage,
  loadMainLayout,
  loadSettingsPage,
} from '../../router/page-loaders'
import { moduleRoutes } from '../modules'

const moduleRouteRecords: RouteRecordRaw[] = moduleRoutes.map((route) => ({
  name: route.name,
  path: route.path,
  component: route.component,
}))

const routes: RouteRecordRaw[] = [
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
