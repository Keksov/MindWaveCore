import { boot } from 'quasar/wrappers'
import { createBodyMonitorPlugin, type BodyMonitorReplayAdapter } from '../../../../BodyMonitorCore/ui/plugin'
import { createGnauralPlugin } from '../../../../GnauralCore/ui/plugin'
import { ensureDefaultWsHandlersRegistered } from 'src/services/register-ws-handlers'
import { wsService } from 'src/services/ws'
import { useReplayStore } from 'stores/replay'

export default boot(({ app }) => {
  const replay: BodyMonitorReplayAdapter = useReplayStore()

  ensureDefaultWsHandlersRegistered()

  app.use(createBodyMonitorPlugin({ ws: wsService, replay }))
  app.use(createGnauralPlugin({ ws: wsService }))
})