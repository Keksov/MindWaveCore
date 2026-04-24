import { wsService } from 'src/services/ws'

export function useWs() {
  return {
    connectionState: wsService.connectionState,
    send: wsService.send
  }
}
