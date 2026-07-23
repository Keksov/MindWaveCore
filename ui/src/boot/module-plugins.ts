import { boot } from 'quasar/wrappers'
import { createBodyMonitorPlugin, type BodyMonitorReplayAdapter } from '../../../../BodyMonitorCore/ui/plugin'
import { createGnauralPlugin } from '../../../../GnauralCore/ui/plugin'
import { PERF_LOG_ENABLED } from '../../../../GnauralCore/ui/composables/perf-log'
import { ensureDefaultWsHandlersRegistered } from 'src/services/register-ws-handlers'
import { wsService } from 'src/services/ws'
import { useReplayStore } from 'stores/replay'

export default boot(({ app }) => {
  const replay: BodyMonitorReplayAdapter = useReplayStore()

  ensureDefaultWsHandlersRegistered()

  app.use(createBodyMonitorPlugin({ ws: wsService, replay }))
  app.use(createGnauralPlugin({ ws: wsService }))

  // undo-log perf investigation (2026-07-22): emits a performance.measure per component per
  // mount/patch/render phase, named "<ComponentName> phase" — perf-log.ts's PerformanceObserver
  // logs any that cross 10ms, naming exactly which component is slow to render.
  // 2026-07-23: gated on the SAME flag as the rest of the diagnostics, so one edit in perf-log.ts
  // turns the whole apparatus off. This is not free: Vue marks+measures EVERY component instance
  // on every lifecycle phase (~200 per edit here), and it is itself a suspect for the uniform,
  // cumulative slowdown — so being able to A/B it in one place is the point.
  app.config.performance = PERF_LOG_ENABLED
})