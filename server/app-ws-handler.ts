import type { ServerWebSocket } from "bun"

export interface AppSocketData {
  readonly kind: "app"
}

export const handleAppMessage = (
  aSocket: ServerWebSocket<AppSocketData>,
  aMessage: string
): void => {
  try {
    const parsed = JSON.parse(aMessage)
    if (typeof parsed === "object" && parsed !== null) {
      aSocket.send(JSON.stringify({ type: "ack" }))
      return
    }
  } catch {
    // ignore parse errors for now; app integration is phase 1+
  }

  aSocket.send(JSON.stringify({ type: "error", payload: { message: "Invalid app message" } }))
}
