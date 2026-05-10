import type { BodyMonitorServerEvent, ServerEvent } from '@protocol'
import { useAudioStore } from 'stores/audio'
import { useSessionStore } from 'stores/session'
import { useDeviceStore } from 'stores/device'
import { useReplayStore } from 'stores/replay'
import { useEegDiagnosticsStore } from '../../../BodyMonitorCore/ui/stores/eeg-diagnostics'
import { wsService } from './ws'

let isRegistered = false

function isAudioEvent(event: ServerEvent): boolean {
  return event.type.startsWith('audio_')
}

function isBodyMonitorEvent(event: ServerEvent): event is BodyMonitorServerEvent {
  return !event.type.startsWith('audio_')
}

export function ensureDefaultWsHandlersRegistered(): void {
  if (isRegistered) {
    return
  }

  wsService.registerHandler((event) => {
    if (!isAudioEvent(event)) {
      return false
    }

    const audio = useAudioStore()

    switch (event.type) {
      case 'audio_status':
        audio.handleStatus(event)
        return true
      case 'audio_progress':
        audio.handleProgress(event)
        return true
      case 'audio_error':
        audio.handleError(event)
        return true
      case 'audio_exit':
        audio.handleExit(event)
        return true
      case 'audio_render_progress':
        audio.handleRenderProgress(event)
        return true
      case 'audio_render_done':
        audio.handleRenderDone(event)
        return true
      case 'audio_schedule_loaded':
        audio.handleScheduleLoaded(event)
        return true
    }

    return false
  })

  wsService.registerHandler((event) => {
    const replay = useReplayStore()

    switch (event.type) {
      case 'replay_started':
        replay.handleReplayStarted(event)
        return true
      case 'replay_paused':
        replay.handleReplayPaused(event)
        return true
      case 'replay_progress':
        replay.handleReplayProgress(event)
        return true
      case 'replay_stopped':
        replay.handleReplayStopped(event)
        return true
      case 'replay_finished':
        replay.handleReplayFinished(event)
        return true
    }

    return false
  })

  wsService.registerHandler((event) => {
    const replay = useReplayStore()
    if (!isBodyMonitorEvent(event)) {
      return false
    }

    if (!replay.isReplayTransportActive) {
      if (replay.isReplayErrorRoutingActive && event.type === 'bodymonitor_error') {
        replay.handleReplayEvent(event)
        return true
      }

      return false
    }

    replay.handleReplayEvent(event)
    return true
  })

  wsService.registerHandler((event) => {
    const session = useSessionStore()
    const device = useDeviceStore()
    const eegDiagnostics = useEegDiagnosticsStore()

    switch (event.type) {
      case 'bodymonitor_status':
        session.handleStatus(event)
        return true
      case 'bodymonitor_started':
        session.handleStarted(event)
        return true
      case 'bodymonitor_scan_command':
        session.handleScanCommand(event)
        return true
      case 'bodymonitor_output':
        session.handleOutput(event)
        eegDiagnostics.handleOutput(event)
        return true
      case 'bodymonitor_exit':
        session.handleExit(event)
        return true
      case 'bodymonitor_error':
        session.handleError(event)
        return true
      case 'bodymonitor_device':
        device.handleDevice(event)
        return true
      case 'bodymonitor_devices':
        device.handleDevices(event)
        return true
      case 'bodymonitor_ping_result':
        device.handlePingResult(event)
        eegDiagnostics.handlePingResult(event)
        return true
      case 'bodymonitor_eeg_diagnostics':
        eegDiagnostics.handleEegDiagnostics(event)
        return true
      case 'bodymonitor_scan_device_status':
        device.handleScanDeviceStatus(event)
        session.handleScanDeviceStatus(event)
        return true
      case 'bodymonitor_stdio_ack':
        session.handleStdioAck(event)
        return true
      case 'bodymonitor_stdio_ready':
        session.handleStdioReady()
        return true
      case 'bodymonitor_server_ready':
        return true
    }

    return false
  })

  isRegistered = true
}