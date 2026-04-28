import { boot } from 'quasar/wrappers'
import { createBodyMonitorPlugin, type BodyMonitorReplayAdapter } from '../../../../BodyMonitorCore/ui/plugin'
import { createGnauralPlugin } from '../../../../GnauralCore/ui/plugin'
import { wsService } from 'src/services/ws'
import { useReplayStore } from 'stores/replay'

export default boot(({ app }) => {
  const replay: BodyMonitorReplayAdapter = useReplayStore()

  app.use(createBodyMonitorPlugin({ ws: wsService, replay }))
  app.use(createGnauralPlugin({ ws: wsService }))
})