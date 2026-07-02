# Spectrogram fixes

Status: **active** (plan written; approval gate SF0.2 before execution)
Created: 2026-07-01
Authoritative progress ledger: [spectrogram-fixes-progress.json](spectrogram-fixes-progress.json)

Goal: fix three spectrogram defects reported by the owner:
1. **No loading indicator** while the spectrogram is being prepared.
2. **Only the last frame renders** — on opening a file a single narrow strip (one
   tile) runs left→right and stops at the far right; the rest of the spectrum is
   never shown (tiles do not persist/accumulate in the render).
3. The spectrogram **settings side panel** should be titled **"Параметры"** and behave
   like the other parameter side panels — a toggleable **overlay** that does not resize
   the main content.

## 1. Where things stand (verified 2026-07-01)
All three live in the Gnaural audio UI (worker/WS spectrogram from the Spectrogram UI plan).

- **Item 1 (loading).** [use-spectrogram.ts](../../../GnauralCore/ui/composables/use-spectrogram.ts)
  exposes `loading` (true while the analysis is opening or tiles are pending), but
  [SpectrogramView.vue](../../../GnauralCore/ui/components/SpectrogramView.vue) never
  surfaces it. AudioPage only shows `audio.spectrogramLoading` (the WAV **decode**), so
  during worker open + tile fetch there is no indicator.
- **Item 2 (only last frame).** Confirmed repro (owner): **on opening a file, no playback
  needed** — a narrow one-tile strip renders, slides left→right as tiles arrive, and only
  the last (rightmost) tile stays. The client tiling/cache is sound in isolation
  ([spectrogram-tiles.ts](../../../GnauralCore/ui/composables/spectrogram-tiles.ts):
  `planVisibleTiles` + LRU cache keyed by `analysisId|zoom|tileIndex|viewBinCount`), and
  `analysisParams`/`renderOptions` are **stable computeds** (no re-open churn there). The
  symptom means the **rendered set holds a single tile at a time** instead of accumulating.
  Leading hypothesis: view/seq churn during the initial load — `ResizeObserver` +
  `openForPath` both call `applyView()`→`setView()` (bumping `viewSeq` and, if the canvas
  height settles, `viewBinCount`), so tile keys shift and `assembleVisibleTiles()` (keyed on
  the current plan) only matches the most-recently-fetched tile. Tile arrivals also only
  re-assemble when `pending.seq === viewSeq`, so churn drops earlier tiles from the display.
  To be confirmed at execution with instrumentation + a composable unit test.
- **Item 3 (settings panel).** In [AudioPage.vue](../../../GnauralCore/ui/pages/AudioPage.vue)
  the spectrogram tab renders `<spectrogram-view class="col">` next to a fixed
  `flex: 0 0 264px` column holding [SpectrogramSettingsPanel.vue](../../../GnauralCore/ui/components/SpectrogramSettingsPanel.vue)
  — always visible, resizing the plot. The overlay pattern to mirror is
  `GnauralScheduleView`'s settings panel: an absolutely-positioned `aside` (right/top/bottom,
  `z-index`, `<transition>`) + a click backdrop + a toolbar toggle. The panel has no overall
  title today (only per-group titles).

## 2. Decisions (SF-D1 … SF-D5) — locked at SF0.2
- **SF-D1 — Scope & process.** 3 items → 3 phases. Per-step atomic commits (step-id prefixed,
  Co-Authored-By); **NO push**; phase-boundary pauses; `vue-tsc` + `bun` green for each step.
  All code in GnauralCore; the ledger lives here in MindWaveCore.
- **SF-D2 — Loading indicator.** Surface the worker/tile loading in `SpectrogramView` as an
  overlay spinner driven by `spec.loading` (analysis open + tiles pending). Keep the existing
  `audio.spectrogramLoading` (decode) indicator in AudioPage. Result: a spinner is visible for
  the whole "preparing" span (decode → open → first tiles).
- **SF-D3 — Only-last-frame fix.** Make the rendered tile set **persist/accumulate** during
  load: (a) guard `setView`/`applyView` to no-op when the effective view (time window + zoom +
  `viewBinCount`) is unchanged, killing redundant `viewSeq` churn; (b) re-`assembleVisibleTiles()`
  on every tile arrival against the current cache (not only when `pending.seq === viewSeq`); (c)
  a final assemble + redraw when `loading` clears. Exact root cause confirmed at execution via
  instrumentation; covered by a new composable unit test (tiles accumulate across a
  binCount/seq change) so the regression is guarded automatically.
- **SF-D4 — Settings panel = overlay named "Параметры".** Convert the fixed side column into a
  toggleable overlay mirroring the schedule settings panel: an absolutely-positioned `aside`
  over the plot (no main-content resize) + a backdrop + a `<transition>`, opened by a toolbar
  toggle button. Panel header title = **"Параметры"** (`audio.spectrogramSettingsTitle`, en
  "Parameters"/ru "Параметры") + a close (×) button. Default **closed**.
- **SF-D5 — Toggle placement.** The "Параметры" toggle lives in the `SpectrogramView` toolbar
  (next to zoom/fit), so open/close state + overlay are self-contained in the view. State may
  be local to the view (not persisted) unless the owner wants persistence.
- **SF-D7 — Audacity-like default track height.** Give the spectrogram plot a taller default
  height matching the Audacity reference (per-channel ~240px; a stereo split ~2× that). Applies
  to `SpectrogramView`/its host in AudioPage instead of the current `min-height: 280px` flex fill.
  *(Owner addition 2026-07-01, "Сделать UI похожим на Audacity" #1.)*
- **SF-D8 — Drag-to-resize track height.** A drag handle on the **bottom border** of the
  spectrogram track resizes its height (pointer drag), like Audacity; the chosen height is
  persisted (localStorage). *(Owner addition #2.)*
- **SF-D10 — Spectrogram generation performance (SF2.1 real concern).** The "only last frame"
  visual bug is resolved (tile-count-by-zoom, worker timeouts, worker multi-analysis, WS
  multicast). The remaining SF2.1 problem is **generation SPEED** — Audacity renders a
  spectrogram far faster. **Profile first, optimize second** (no premature optimization): measure
  each pipeline stage on `d:\bin\Presets\1_Orientation.flac` — worker `open-analysis`, per-tile
  `get-tile` (sample load/FLAC-decode vs FFT), tile payload size + JSON serialize/parse, WS
  transfer, UI render — name the bottleneck, then choose the fix at an approval gate. Suspects to
  confirm/refute: single-threaded worker FFT; JSON (not binary) tile transport of large float
  arrays; repeated per-request FLAC decode (worker reads FLAC directly, no cached PCM). *(Owner
  addition 2026-07-02.)*
- **SF-D11 — Performance optimization approach (A→B→C).** Fix the SF6.1 bottleneck in stages,
  each measured + owner-verified via the UI before the next: **A** (SF6.2) skip computing/storing
  phase + unwrapped-phase unless the data mode needs them (default `magnitude` doesn't) — removes
  ~350M ArcTan2 + the per-frame unwrap + 2 of the 3 ~1.4 GB matrices; **B** (SF6.3) multithread
  the independent per-frame FFT loop; **C** (SF6.4) lazy/progressive per-visible STFT with a
  bounded cache. Order A→B→C, each re-profiled. All are worker (Pascal) changes → rebuild +
  re-bundle + backend restart; per-step commit; pause for manual UI verification each. *(Owner:
  plan all three; implement A first with a UI-verification pause.)*
- **SF-D9 — Split stereo into left/right tracks.** For stereo sources, stack two spectrogram
  panes (Left over Right) like Audacity, each analysing one channel (`channel: 0` / `channel: 1`,
  its own worker analysis); mono renders a single pane. Detect channel count from the decoded
  `AudioBuffer.numberOfChannels` (`audio.spectrogramBuffer`); label the panes L/R. *(Owner
  addition #3.)*
- **SF-D6 — Prepare the spectrum when the Спектрограмма tab is opened.** The Спектрограмма tab
  only renders when `audio.spectrogramBuffer !== null` (decoded); RF4.1 decodes on tree
  *selection*, but if a local audio file is already selected (or selected-but-undecoded) and the
  user just switches to the Спектрограмма tab, nothing decodes and the stale "start local
  playback" message hangs. Fix: when the Спектрограмма view becomes active for a selected
  **local audio** file with no decoded buffer and no decode in flight, trigger
  `audio.ensureLocalAudioReady(selectedPath, kind)` (same non-playback decode as RF4.1), and
  update the obsolete `audio.noSpectrogram` wording (a selected file now auto-prepares; the
  message should cover only the "no file selected" case). Scope: wav/flac; `.gnaural` unchanged.
  *(Owner addition 2026-07-01.)*

## 3. Acceptance / gates
- Item 1: a loading indicator is visible while the spectrogram is preparing (decode + worker
  open + first tiles), then clears. `vue-tsc` clean.
- Item 2: opening a file renders the **whole** spectrogram and it **stays** (no single-tile
  strip, no "only last frame"); panning/zooming still works; new composable test green.
- Item 3: the settings panel is titled "Параметры", opens as an overlay over the plot without
  resizing it, and closes via toggle/backdrop/×; `vue-tsc` + `bun` green.

## 4. Risks
- **Item 2 is a visual/runtime bug** I cannot exercise in the headless webview; the fix is
  reasoned + unit-tested for tile accumulation, with final confirmation as the owner's visual
  gate. If instrumentation reveals a different root cause than the leading hypothesis, SF-D3 is
  updated (locked-decision amendment) before finalizing.
- **Overlay layering** — the spectrogram plot is a canvas; the overlay must sit above it with a
  backdrop and not intercept plot interactions when closed (mirror the schedule panel z-index).

## 5. Steps (checklist mirrors the ledger)
**Phase 0 — Plan & approval**
- [x] **SF0.1 — Plan & ledger.**
- [x] **SF0.2 — Approval gate.** Owner approved (`go`); SF-D2..SF-D5 locked.

**Phase 1 — Loading indicator**
- [x] **SF1.1 — Surface spectrogram preparation loading.** Overlay spinner in `SpectrogramView`
  driven by `spec.loading` (+ `audio.spectrogramPreparing` i18n en/ru). `vue-tsc` clean.

**Phase 2 — Fix only-last-frame render**
- [x] **SF2.1 — Persist/accumulate tiles.** Cache `getByTileIndex` binCount-fallback used by
  `assembleVisibleTiles`; always re-assemble on tile arrival; `setView` no-op guard; rounded
  `viewBinCount`. +4 unit tests (incl. only-last-frame regression). `vue-tsc` clean; bun 60/0.

**Phase 3 — Settings panel overlay "Параметры"**
- [ ] **SF3.1 — Overlay + rename.** Convert the settings panel to a toggleable overlay (no
  main-content resize) titled "Параметры" with a toolbar toggle + backdrop + close; i18n en/ru.
  Verify `vue-tsc` + `bun`.

**Phase 5 — Make the UI Audacity-like** *(owner addition 2026-07-01)*
- [x] **SF5.1 — Audacity-like default track height (SF-D7).** `SpectrogramView` `height` prop +
  AudioPage `spectrogramTrackHeight` (default 260px per track). `vue-tsc` clean.
- [x] **SF5.2 — Drag-resize track height (SF-D8).** Bottom-edge drag handle (pointer-capture,
  clamp 120–1200) via `v-model:height`; height persisted in localStorage. `vue-tsc` + bun 61/0.
- [x] **SF5.3 — Stereo left/right split (SF-D9).** Stacked L/R per-channel panes for stereo
  (single pane for mono), detected via `AudioBuffer.numberOfChannels`. **Required a server
  change:** `SpectrogramSession` now supports multiple concurrent analyses keyed by `analysisId`
  (was single-analysis). server 17/0, ui 61/0, `vue-tsc` clean. **Phase 5 complete.**

**Phase 6 — Spectrogram generation performance** *(owner addition 2026-07-02; SF-D10)*
- [x] **SF6.1 — Profile the pipeline.** Done. Bottleneck = eager full-file STFT in
  `TFftwAnalysis.Create` (18.8 s of a 22.2 s open on the 33-min FLAC); decode 3.4 s; JSON/WS +
  get-tile are fine. Root cause: phase + unwrapped-phase computed/stored for every frame even
  for `data=magnitude`.
- [ ] **SF6.2 — Optimization A: skip unused phase work (SF-D11).** In the worker, compute + store
  phase / unwrapped-phase (and their arrays) only when the data mode needs them (phase/uphase);
  guard point/area-query phase reads. Rebuild + re-bundle. **PAUSE for manual UI verification**;
  re-profile to measure the open-analysis cut.
- [x] **SF6.3 — Optimization B: multithread the STFT loop (SF-D11).** `TStftFrameWorker` +
  `ComputeStandardStftParallel` split the independent per-frame FFTs across
  `ProcessorCount` threads (per-thread plan/buffers; reassignment stays serial). open-analysis
  6.2 s → ~3.06 s (16 CPUs; cumulative A+B 22.2 → 3.06, ~7×); tiles byte-identical; bridge 17/0.
  **PAUSE for manual UI verification.**
- [ ] **SF6.4 — Optimization C: lazy / progressive STFT (SF-D11).** Compute the STFT only for the
  visible window on demand (Audacity-style), with a bounded cache, so `open-analysis` is cheap
  and cost scales with what's shown; re-profile; PAUSE for manual UI verification.

**Phase 4 — Prepare spectrum on tab open**
- [x] **SF4.1 — Auto-prepare on Спектрограмма tab.** `ensureSpectrogramPrepared()` + a watch
  decode the selected local file when the Спектрограмма view opens (no buffer / not loading), so
  it prepares instead of showing the stale message; `audio.noSpectrogram` wording refreshed
  (SF-D6). `vue-tsc` clean; GnauralCore bun 56/0.

## 6. References
- View/render: [SpectrogramView.vue](../../../GnauralCore/ui/components/SpectrogramView.vue),
  [spectrogram-render.ts](../../../GnauralCore/ui/composables/spectrogram-render.ts)
- Fetch/cache: [use-spectrogram.ts](../../../GnauralCore/ui/composables/use-spectrogram.ts),
  [spectrogram-tiles.ts](../../../GnauralCore/ui/composables/spectrogram-tiles.ts)
- Overlay pattern: [GnauralScheduleView.vue](../../../GnauralCore/ui/components/GnauralScheduleView.vue) (`settingsPanelOpen`)
- Host: [AudioPage.vue](../../../GnauralCore/ui/pages/AudioPage.vue) (spectrogram tab)
