import type { Component } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
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
}

export const registeredModules: readonly CoreModuleDescriptor[] = [
  bodyMonitorModule,
  gnauralModule,
]

export const moduleRoutes = registeredModules.flatMap((module) => module.routes)
export const settingsTabs = registeredModules.flatMap((module) => module.settingsTabs)