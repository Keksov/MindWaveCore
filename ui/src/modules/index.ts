import type { Component } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import type { PanelContribution } from '../components/panel/panel-registry'
import { bodyMonitorModule } from '../../../../BodyMonitorCore/ui/module'
import { gnauralModule } from '../../../../GnauralCore/ui/module'

export type MessageTree = Record<string, unknown>
export type LocaleMessages = Record<string, MessageTree>

export interface CoreModuleRouteContribution {
  readonly name: string
  readonly path: string
  readonly navLabelKey: string
  readonly component: NonNullable<RouteRecordRaw['component']>
}

export interface CoreModuleSettingsTabContribution {
  readonly name: string
  readonly icon: string
  readonly labelKey: string
  readonly component: Component
}

export interface CoreModuleDescriptor {
  readonly id: string
  readonly messages: LocaleMessages
  readonly routes: readonly CoreModuleRouteContribution[]
  readonly settingsTabs: readonly CoreModuleSettingsTabContribution[]
  // PW2.1 (PW-D4): panels the module can show in a detached child window (PanelHostPage).
  readonly panels?: readonly PanelContribution[]
}

export const registeredModules: readonly CoreModuleDescriptor[] = [
  bodyMonitorModule,
  gnauralModule,
]

export const moduleRoutes = registeredModules.flatMap((module) => module.routes)
export const settingsTabs = registeredModules.flatMap((module) => module.settingsTabs)
export const modulePanels: readonly PanelContribution[] = registeredModules.flatMap((module) => module.panels ?? [])