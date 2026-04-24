import type { Server } from "bun"
import type { ProcessManagerCallbacks, ProcessStateSnapshot } from "./process-manager"
import {
  toJson,
  type DeviceInfo,
  type BodyMonitorServerEvent,
  type BodyMonitorStdioAckEvent
} from "./protocol"

interface UiPublishSocketData {
  readonly kind: "ui"
}

export interface PublishCallbackHooks {
  readonly onEvent?: (aEvent: BodyMonitorServerEvent) => void
  readonly onStateChange?: (aSnapshot: ProcessStateSnapshot) => void
  readonly onError?: (aMessage: string, aRunId?: string) => void
  readonly onExit?: (aRunId: string, aExitCode: number) => void
  readonly onStdioReady?: () => void
}

const publishEvent = <T extends UiPublishSocketData>(
  aServer: Server<T>,
  aEvent: BodyMonitorServerEvent
): void => {
  aServer.publish("ui", toJson(aEvent))
}

const emitEvent = <T extends UiPublishSocketData>(
  aServer: Server<T>,
  aEvent: BodyMonitorServerEvent,
  aHooks: PublishCallbackHooks
): void => {
  try {
    aHooks.onEvent?.(aEvent)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to archive server event"
    console.error(`[publish] ${message}`)
  }

  publishEvent(aServer, aEvent)
}

export const createPublishCallbacks = <T extends UiPublishSocketData>(
  aServer: Server<T>,
  aHooks: PublishCallbackHooks = {}
): ProcessManagerCallbacks => {
  return {
    onStateChange(aSnapshot: ProcessStateSnapshot) {
      emitEvent(aServer, {
        type: "bodymonitor_status",
        ...aSnapshot
      }, aHooks)
      aHooks.onStateChange?.(aSnapshot)
    },
    onStarted(aRunId: string, aParams: readonly string[], aCommandLine: string) {
      emitEvent(aServer, {
        type: "bodymonitor_started",
        runId: aRunId,
        params: aParams,
        commandLine: aCommandLine
      }, aHooks)
    },
    onScanCommand(aRunId: string, aCommandLine: string) {
      emitEvent(aServer, {
        type: "bodymonitor_scan_command",
        runId: aRunId,
        cmd: "list_devices",
        commandLine: aCommandLine
      }, aHooks)
    },
    onLine(aEvent) {
      emitEvent(aServer, aEvent, aHooks)
    },
    onDevice(aRunId: string, aDevice: DeviceInfo) {
      emitEvent(aServer, {
        type: "bodymonitor_device",
        runId: aRunId,
        device: aDevice
      }, aHooks)
    },
    onDevices(aRunId: string, aDevices: readonly DeviceInfo[]) {
      emitEvent(aServer, {
        type: "bodymonitor_devices",
        runId: aRunId,
        devices: aDevices
      }, aHooks)
    },
    onError(aMessage: string, aRunId?: string) {
      emitEvent(aServer, {
        type: "bodymonitor_error",
        message: aMessage,
        runId: aRunId
      }, aHooks)
      aHooks.onError?.(aMessage, aRunId)
    },
    onExit(aRunId: string, aExitCode: number) {
      emitEvent(aServer, {
        type: "bodymonitor_exit",
        runId: aRunId,
        exitCode: aExitCode
      }, aHooks)
      aHooks.onExit?.(aRunId, aExitCode)
    },
    onStdioAck(aAck: BodyMonitorStdioAckEvent) {
      emitEvent(aServer, aAck, aHooks)
    },
    onStdioReady() {
      emitEvent(aServer, { type: "bodymonitor_stdio_ready" }, aHooks)
      aHooks.onStdioReady?.()
    }
  }
}
