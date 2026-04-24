import type { ServerWebSocket } from "bun"
import type { LogArchiveStore } from "./log-db"
import type { LogReplayManager, ReplayPublisher } from "./log-replay"
import { isAudioBrowserMessage, isBrowserMessage, toJson } from "./protocol"
import type { AppSession } from "../../BodyMonitorCore/server"
import type { GnauralSession } from "../../GnauralCore/server"

export interface UiSocketData {
  readonly kind: "ui"
}

export interface UiWsContext {
  readonly audioSession: GnauralSession
  readonly archiveStore: LogArchiveStore
  readonly replayManager: LogReplayManager
  readonly replayPublisher: ReplayPublisher
}

const sendUiError = (aSocket: ServerWebSocket<UiSocketData>, aMessage: string): void => {
  aSocket.send(
    toJson({
      type: "bodymonitor_error",
      message: aMessage
    })
  )
}

const sendAudioError = (aSocket: ServerWebSocket<UiSocketData>, aMessage: string): void => {
  aSocket.send(
    toJson({
      type: "audio_error",
      message: aMessage,
    })
  )
}

export const handleUiOpen = (
  aSocket: ServerWebSocket<UiSocketData>,
  aProcessManager: AppSession,
  aContext: UiWsContext
): void => {
  aSocket.send(
    toJson({
      type: "bodymonitor_status",
      ...aProcessManager.getState()
    })
  )
  aSocket.send(
    toJson(aContext.audioSession.getStatus())
  )

  const replaySnapshot = aContext.replayManager.getSnapshot()
  if (replaySnapshot !== null) {
    aSocket.send(toJson(replaySnapshot))
  }
}

export const handleUiMessage = async (
  aSocket: ServerWebSocket<UiSocketData>,
  aProcessManager: AppSession,
  aMessage: string,
  aContext: UiWsContext
): Promise<void> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(aMessage)
  } catch {
    console.warn("[ui:ws] invalid-json")
    sendUiError(aSocket, "Invalid JSON request")
    return
  }

  if (!isBrowserMessage(parsed)) {
    console.warn("[ui:ws] invalid-message")
    sendUiError(aSocket, "Unknown browser message type")
    return
  }

  console.log(`[ui:ws] ${parsed.type}`)

  if (isAudioBrowserMessage(parsed)) {
    try {
      if (parsed.type === "audio_start") {
        await aContext.audioSession.start(parsed.filePath, aContext.archiveStore.getAudioSettings())
        return
      }

      if (parsed.type === "audio_stop") {
        aContext.audioSession.stop()
        return
      }

      if (parsed.type === "audio_pause") {
        aContext.audioSession.pause()
        return
      }

      if (parsed.type === "audio_resume") {
        aContext.audioSession.resume()
        return
      }

      if (parsed.type === "audio_seek") {
        aContext.audioSession.seek(parsed.positionSec)
        return
      }

      if (parsed.type === "audio_set_volume") {
        aContext.audioSession.setVolume(parsed.left, parsed.right)
        return
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Audio command failed"
      sendAudioError(aSocket, message)
    }

    return
  }

  if (parsed.type === "replay_start") {
    const result = await aContext.replayManager.startReplay(aContext.replayPublisher, parsed.sessionId)
    if (!result.ok) {
      sendUiError(aSocket, result.error ?? "Replay start failed")
    }
    return
  }

  if (parsed.type === "replay_stop") {
    const stopped = await aContext.replayManager.stopReplay(aContext.replayPublisher)
    if (!stopped) {
      sendUiError(aSocket, "Replay is not active")
    }
    return
  }

  if (parsed.type === "replay_set_speed") {
    if (!aContext.replayManager.setReplaySpeed(aContext.replayPublisher, parsed.speed)) {
      sendUiError(aSocket, "Replay is not active")
    }
    return
  }

  if (aContext.replayManager.isActive()) {
    const stopped = await aContext.replayManager.stopReplay(aContext.replayPublisher)
    if (!stopped) {
      sendUiError(aSocket, "Replay is active but could not be stopped")
      return
    }
  }

  aContext.archiveStore.noteBrowserMessage(parsed, aProcessManager.getState())

  if (parsed.type === "bodymonitor_server_list_devices") {
    aProcessManager.sendServerListDevices()
    return
  }

  if (parsed.type === "bodymonitor_stdio_configure") {
    aProcessManager.sendStdioConfigure(parsed.params)
    return
  }

  if (parsed.type === "bodymonitor_stdio_start") {
    aProcessManager.sendStdioStart()
    return
  }

  if (parsed.type === "bodymonitor_stdio_stop") {
    aProcessManager.sendStdioStop()
    return
  }

  if (parsed.type === "bodymonitor_stdio_setparam") {
    aProcessManager.sendStdioSetParam(parsed.key, parsed.value)
    return
  }

  if (parsed.type === "bodymonitor_stdio_quit") {
    aProcessManager.sendStdioQuit()
    return
  }
}

