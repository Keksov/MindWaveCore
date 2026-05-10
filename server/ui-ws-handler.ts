import type { ServerWebSocket } from "bun"
import type { LogArchiveStore } from "./log-db"
import type { LogReplayManager, ReplayPublisher } from "./log-replay"
import { prepareAlphaRelaxationSchedule } from "./alpha-relaxation-schedule"
import { prepareSleepDrowseSchedule } from "./sleep-drowse-schedule"
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

const startAlphaRelaxationAudio = async (aContext: UiWsContext, aDurationMin: number): Promise<void> => {
  const schedule = await prepareAlphaRelaxationSchedule(aDurationMin)
  await aContext.audioSession.start(
    schedule.filePath,
    aContext.archiveStore.getAudioSettings(),
    [schedule.rootPath],
  )
}

const startSleepDrowseAudio = async (aContext: UiWsContext, aDurationMin: number): Promise<void> => {
  const schedule = await prepareSleepDrowseSchedule(aDurationMin)
  await aContext.audioSession.start(
    schedule.filePath,
    aContext.archiveStore.getAudioSettings(),
    [schedule.rootPath],
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

  const replaySnapshots = aContext.replayManager.getSnapshotEvents()
  for (const replaySnapshot of replaySnapshots) {
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

      if (parsed.type === "audio_alpha_relaxation_start") {
        await startAlphaRelaxationAudio(aContext, parsed.durationMin)
        return
      }

      if (parsed.type === "audio_alpha_relaxation_stop") {
        aContext.audioSession.stop()
        return
      }

      if (parsed.type === "audio_sleep_drowse_start") {
        await startSleepDrowseAudio(aContext, parsed.durationMin)
        return
      }

      if (parsed.type === "audio_sleep_drowse_stop") {
        aContext.audioSession.stop()
        return
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Audio command failed"
      sendAudioError(aSocket, message)
    }

    return
  }

  if (parsed.type === "bodymonitor_request_alpha_relaxation_start") {
    try {
      await startAlphaRelaxationAudio(aContext, parsed.durationMin)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Alpha relaxation audio start failed"
      sendUiError(aSocket, message)
    }
    return
  }

  if (parsed.type === "bodymonitor_request_alpha_relaxation_stop") {
    aContext.audioSession.stop()
    return
  }

  if (parsed.type === "bodymonitor_request_sleep_drowse_start") {
    try {
      await startSleepDrowseAudio(aContext, parsed.durationMin)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sleep drowse audio start failed"
      sendUiError(aSocket, message)
    }
    return
  }

  if (parsed.type === "bodymonitor_request_sleep_drowse_stop") {
    aContext.audioSession.stop()
    return
  }

  if (parsed.type === "replay_start") {
    const result = await aContext.replayManager.startReplay(aContext.replayPublisher, parsed.sessionId, parsed.timestampMs)
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

  if (parsed.type === "replay_pause") {
    if (!aContext.replayManager.pauseReplay(aContext.replayPublisher)) {
      sendUiError(aSocket, "Replay cannot be paused")
    }
    return
  }

  if (parsed.type === "replay_seek") {
    if (!await aContext.replayManager.seekReplay(aContext.replayPublisher, parsed.timestampMs)) {
      sendUiError(aSocket, "Replay seek failed")
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

  aContext.archiveStore.noteBrowserMessage(
    parsed,
    aProcessManager.getState(),
    aContext.audioSession.getLoadedSchedule(),
    aContext.audioSession.getLoadedScheduleStartedAtMs(),
  )

  if (parsed.type === "bodymonitor_server_list_devices") {
    aProcessManager.sendServerListDevices()
    return
  }

  if (parsed.type === "bodymonitor_server_ping_device") {
    const result = await aProcessManager.pingDevice(parsed.mac)
    aContext.replayPublisher.publish("ui", toJson(result))
    return
  }

  if (parsed.type === "bodymonitor_server_diagnose_eeg") {
    const result = await aProcessManager.diagnoseEeg(parsed.mac)
    aContext.replayPublisher.publish("ui", toJson(result))
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

