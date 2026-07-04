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
- **SF-D21 — Common header above the track stack (Phase 10 item 1).** Above the first track
  render one shared header bar that holds ALL control buttons (zoom in / zoom out / fit). The
  buttons leave the per-track toolbar; they exist once for the whole spectrogram. The readout
  does NOT live in the header — see SF-D25 (cursor tooltip). *(Owner 2026-07-02.)*
- **SF-D26 — Remove the "Спектрограмма" subtitle under the transport (Phase 10 item 5).** Drop
  the `audio.spectrogramTitle` `text-subtitle2` line between the Старт/transport toolbar and the
  plot in the spectrogram tab. *(Owner 2026-07-02.)*
- **SF-D27 — i18n for the Параметры panel (Phase 11 item 1).** Audit `SpectrogramSettingsPanel`
  (and any spectrogram controls) for hardcoded/untranslated strings and route them through
  i18n (en/ru), so the whole parameters panel is localized. *(Owner 2026-07-03.)*
- **SF-D28 — Fix spectrogram caching across file switches (Phase 11 item 2).** SF7.3's warm
  analysis LRU is not actually reused: switching A → B → A recomputes A from scratch. Find why
  the reuse path misses (cache key mismatch, close/dispose evicting, per-socket session
  lifecycle, or the UI re-opening with changed params) and make returning to a recent file skip
  the re-decode/STFT. *(Owner 2026-07-03.)*
- **SF-D31 — Bounded-oversample max-pool (Phase 11, quality fix for SF11.4).** SF11.4 (one FFT per
  column) restored speed but dropped the old max-pool (256:1 info loss) → visually much worse
  overview. Fix: in the display-res path compute **K = min(Factor, KMAX≈32)** FFTs per output
  column (sub-stride `Factor/K`) and take the **max** per display bin → restores the bright,
  transient-preserving overview close to the old full-res look, at a fraction of the cost. Since
  JSON emit is now the floor (~500 ms/tile), the extra FFTs are ~free. Adaptive: shallow zoom
  (`Factor ≤ KMAX`) computes the whole bucket (full quality). *(Owner 2026-07-03, agreed.)*
- **SF-D35 — Settings panel: Audacity-parity grouping (Phase 13 item 1).** Regroup the
  `SpectrogramSettingsPanel` fields into Audacity-style sections (see owner's attach): **Масштаб**
  (freq scale / min Hz / max Hz), **Цвет** (intensity scale, gain, range, limit, HF-boost,
  saturation, palette), **FFT-фильтр** (algorithm/data, window size, window type, zero-padding,
  hop, overlap, channel mode, channel). *(Owner 2026-07-04.)*
- **SF-D36 — i18n for parameter VALUES (Phase 13 item 2).** Localize the dropdown option values
  (window functions, data/algorithm, freq scale, intensity scale, channel mode, palette), like
  Audacity ("Тип окна: Ханна", "Алгоритм: Частоты", "Шкала: Логарифмическая", "Тема: Цвет
  (розовый)") — en/ru. *(Owner 2026-07-04.)*
- **SF-D37 — Per-parameter help (Phase 13 item 3).** A "?" icon next to each parameter opening a
  short help popover for that parameter; help text written en/ru. *(Owner 2026-07-04.)*
- **SF-D34 — Fix the TSpecFft real-FFT mirror bug (Phase 12).** `TSpecFft.RealFFTf` +
  `ReorderToFreq` (`SpectrumCore/src/core/SpectrumCoreFft.pas`, ported from Audacity `hfft.cpp`)
  produce a spurious mirror peak at bin `N/2−k` for a real cosine at bin `k` — up to ~80 % of the
  true peak, bin-dependent — folding the magnitude spectrum about `N/4`. Also affects
  `SpectrumCoreStft.pas` (same `RealFFTf`+`ReorderToFreq`+`Sqrt(re²+im²)` pattern) and anything
  built on it. **SCOPE NOTE — independent of the spectrogram work:** the MindWave spectrogram
  worker uses the **FFTW** path (`TFftwAnalysis` / `fftwf_*`), which is NOT affected; this is a
  distinct SpectrumCore core bug (surfaced by the SoundCore voice engine, worked around there by
  band-limiting ≤10 kHz). Root-cause hypotheses (per the report): a bit-reversal indexing error in
  `ReorderToFreq` (`FBitReversed`), or the `RealFFTf` conjugate-symmetric "massage" leaving the
  negative-freq half where the positive half is read; compare bin-by-bin against the original
  Audacity `RealFFTf`/`ReorderToFreq` for a transcription error. Verify with the report's 10 cases
  (cosine/sine sweep, impulse, DC, Nyquist, two-tone, FFTW/NumPy reference match < 1e-3, Parseval,
  inverse round-trip) across `N ∈ {256,512,1024,2048,4096}`; **clean = every non-signal bin < 0.1 %
  of the true peak**. Ref: `SpectrumCore/TSPECFFT-MIRROR-BUG.md`. *(Owner addition 2026-07-04.)*
- **SF-D33 — Shared decode for stereo (Phase 11, SF11.7).** End-to-end profile: after first load
  everything is fast (tiles 0.4–1.2 s, repeat/return 0 ms via SF11.2 + warm LRU); the first-load
  bottleneck is the FLAC **decode** (~2.7–5.6 s/channel), and stereo decodes the file TWICE (once
  per channel analysis: ~8.3 s total). Fix: decode a file's PCM once and let both channel analyses
  reuse it, so the 2nd channel skips the FLAC decode. B2 closed as obsolete (decode, not STFT, is
  the bottleneck). *(Owner 2026-07-04, agreed.)*
- **SF-D32 — Binary tile transport (Phase 11, speed — promotes backlog B4).** JSON float
  serialization (`FloatToStrF` per value, ~500 ms/tile) is the real remaining bottleneck (compute
  is now negligible). Send tile bins as a float32 blob instead of JSON text → the actual perceived
  speedup. *(Owner 2026-07-03, agreed — after SF11.5 quality is verified.)*
- **SF-D30 — Audacity-style display-resolution STFT (Phase 11 item 3, step 2) — DESIGN, awaiting go.**
  Root cause (measured): our worker computes the FULL-resolution STFT for a tile's whole span
  (e.g. 171144 FFTs for a 33-min overview) then max-pools to ~168 columns → cold overview ~3.9 s;
  zoom/pan to new tiles recompute. Audacity (`SpecCache::Populate`/`CalculateOneSpectrum`,
  `lib/vendor/audacity/3.7.8/src/tracks/playabletrack/wavetrack/ui/SpectrumCache.cpp`) computes
  exactly ONE windowSize FFT **per display column** at `from = where[0] + xx*samplesPerPixel`
  (`samplesPerPixel = sampleRate/pixelsPerSecond`), reusing overlapping columns on pan, cached by
  `samplesPerPixel`. So its FFT count = display width (~1–2k), independent of clip length → instant
  zoom/overview. **Plan:** add a display-resolution STFT path to the worker: for a get-tile,
  compute `emittedColumns` windowSize FFTs at stride `samplesPerPixel = spanSamples/emittedColumns`
  (reuse the Opt-B parallel pool + Opt-A magnitude-only), map each to `viewBinCount` display bins,
  and drop the full-res EnsureRange+pyramid for zoomed views (zoom≈0/full-res path unchanged). Keep
  the W3 + SF11.2 caches (now caching cheap tiles) and the existing pan copy-range reuse. **Tradeoff
  (accept):** zoomed-out views become an approximation (windows spaced > windowSize skip samples
  between columns) — exactly Audacity's behaviour; loses the current max-pool peak preservation for
  overviews. Expected: cold overview ~3.9 s → <~100 ms. **Cursor readout unaffected:** point-query /
  area-query keep their own full-resolution path (`PointQuery` → `EnsureRange(frameIndex, 1)` at the
  exact time/bin), so time/freq/dB under the mouse stay accurate (independent of the raster). Minor:
  on deep overviews the exact readout may differ slightly from the approximated pixel — same as
  Audacity, and arguably more accurate. *(Owner-gated: study done; awaiting go to implement the
  worker change — rebuild + rebundle + tests + re-profile + UI verify.)*
- **SF-D29 — Speed up tile generation (Phase 11 item 3).** Audacity renders faster on the same
  files. Step 1 (this phase): profile OUR pipeline's `get-tile` path (worker STFT-on-demand +
  tile build + JSON/WS + UI raster) and apply any wins found, then owner verifies. Step 2 (only
  if step 1 is insufficient): study the Audacity 3.7.8 sources at
  `c:\projects\KKMindWave\SpectrumCore\lib\vendor\audacity\3.7.8` to learn why it's faster and
  port the approach. *(Owner 2026-07-03.)*
- **SF-D25 — Readout as a cursor tooltip (Phase 10).** The area/point readout (peak dB / value
  under the pointer) is shown as a tooltip at the mouse position on the plot, not in the header
  or the bottom bar. *(Owner 2026-07-02.)*
- **SF-D22 — L/R labels as matching top-left overlays (Phase 10 item 2).** The `L` label must
  sit in the SAME place as `R` — a top-left corner overlay on the plot — not in the toolbar.
  Both channel labels become plot overlays. *(Owner 2026-07-02.)*
- **SF-D23 — Time axis only at top-of-first + bottom-of-last (Phase 10 item 3).** The horizontal
  time ruler is drawn only above the first track and below the last track (so with >2 tracks the
  middle ones carry no time ruler). The vertical frequency axis stays on every track. *(Owner
  2026-07-02.)*
- **SF-D24 — Fixed bottom minimap-overview selector (Phase 10 item 4) — DECIDED.** Move the
  timespan selector out of the header to a fixed bar at the very bottom of the spectrogram window
  (position does not change). Owner chose a **full minimap-style overview** (canvas overview +
  draggable/resizable visible-window handle), modelled on the schedule view's 68px bottom minimap
  — NOT a relocated `q-range` slider. The readout moves to a cursor tooltip (SF-D25), so the
  header holds only buttons. *(Owner 2026-07-02; decided.)*
- **SF-D18 — Square track corners (Phase 9 item 1).** Remove the `border-radius` on the
  spectrogram track block (`.spectrogram-view`) so tracks are square-cornered like Audacity.
  *(Owner 2026-07-02.)*
- **SF-D19 — 2px divider = mutual resize between adjacent tracks (Phase 9 item 2).** Between
  stacked tracks render a 2px horizontal divider line; dragging it does a MUTUAL resize — the
  track above and the track below change in opposite directions (one shrinks, the other grows;
  their combined height stays ~constant). Requires per-track heights (not one shared value).
  *(Owner 2026-07-02. NOTE: owner wrote "одна уменьшается, вторая уменьшается" — read as
  one shrinks / the other grows, the standard boundary drag; confirm if a different behaviour is
  intended.)*
- **SF-D20 — Bottom handle = uniform resize of all tracks (Phase 9 item 3).** The resize area at
  the bottom of the LAST track resizes ALL tracks by the same amount (equal heights), unlike the
  divider (which is mutual). Move resize handling to the AudioPage stack: per-track dividers +
  one bottom handle; SpectrogramView takes height as a plain prop (its own SF5.2 handle is removed
  / superseded). *(Owner 2026-07-02.)*
- **SF-D15 — Audacity-style multi-track chrome (Phase 8 item 1).** For a stereo split (>1 track):
  show the control icons/toolbar (zoom / fit / range / readout) on the **first track only**; give
  **each** track its own bottom resize handle; make the **span/area selector unified across all
  tracks** (a time-span selection on any track applies to + renders on all; lift the selection
  state to the parent/shared store); remove the inter-track chrome/gap so tracks abut like
  Audacity. Guard: click→seek + hover readout still map correctly per track. *(Owner 2026-07-02.)*
- **SF-D16 — Adaptive frequency-axis tick density (Phase 8 item 2).** The vertical (frequency)
  axis should reveal more level labels as the track grows (fewer when short) — like Audacity —
  instead of a fixed ~6 ticks. Derive the tick target from the plot height. *(Owner 2026-07-02.)*
- **SF-D17 — Don't auto-build on Audio-tab open (Phase 8 item 3) — DECIDED: option (a).** Build
  the spectrum only on an explicit user action — a tree file *click* (RF4.1 handleSelectedPathChange)
  or switching *to* the Спектрограмма sub-tab — NOT on tab/page mount for a restored selection.
  Implementation: drop `immediate: true` from the SF4.1 `ensureSpectrogramPrepared` watch so it
  only fires on real subsequent changes, not on mount. *(Owner 2026-07-02; decided.)*
- **SF-D12 — Non-blocking load progress (item 1).** On selecting a file, render the tracks
  (spectrogram/schedule) view immediately and show a small **progress dialog overlay** (Audacity
  style) while the audio decode / spectrogram prepare runs — instead of the current full-panel
  "Загрузка выбранного аудиофайла и расчёт спектрограммы…" placeholder that hides the tracks.
  *(Owner addition 2026-07-02.)*
- **SF-D13 — Track-height resize without recompute (item 2) — DECIDED: option (b).** Owner chose
  "never recompute on resize". `viewBinCount` becomes a **fixed constant** (decoupled from track
  height; e.g. 512) so a height-only resize leaves the view (time window + zoom + viewBinCount)
  unchanged → the existing `setView` no-op guard skips any refetch, and the raster simply scales
  to the new height (`drawImage` already stretches to the plot height). Tradeoff (accepted):
  enlarging a track shows the fixed-resolution raster stretched (slightly softer), never recomputed.
  Width/time zoom still refetch as before. *(Owner addition 2026-07-02; decided.)*
- **SF-D14 — Cache computed spectrograms across file switches (item 3).** Returning to a
  previously-opened file recomputes from scratch. Since Opt C made analyses lazy (samples-only,
  ~350 MB each, no giant matrix), keep an **LRU of a few open worker analyses** keyed by
  file+params so switching back reuses the open analysis (bounded by memory); evict oldest.
  Alternative: a client-side tile cache keyed by file+params. Recommend the worker-analysis LRU;
  refine cap at execution. *(Owner addition 2026-07-02.)*
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
- [x] **SF3.1 — Overlay + rename.** Settings panel is now a toggleable overlay (no main-content
  resize) titled "Параметры" with a common-header toggle (`tune`) + backdrop + close (button /
  backdrop / Escape); default closed; i18n en/ru. `vue-tsc` + prod build + bun 61/0.

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
- [x] **SF6.4 — Optimization C: lazy / progressive STFT (SF-D11).** No persistent full-file
  matrix: keep samples; compute the requested frame range on demand (parallel) into a transient
  buffer that a biased `FMagnitudeData` maps onto (readers unchanged); reassignment stays eager.
  Fixes the `open-analysis Out of memory` on `1_Orientation.flac` stereo. open 2.6 s (decode-only);
  tiles byte-identical; bridge 17/0. **PAUSE for manual UI verification.**

**Phase 7 — UX & perf refinements** *(owner addition 2026-07-02)*
- [x] **SF7.1 — Immediate tracks + progress-dialog overlay (SF-D12).** Full-panel loading
  placeholder replaced by a small persistent progress dialog over the tracks screen. `vue-tsc` clean.
- [x] **SF7.2 — Track-height resize without recompute (SF-D13 = option b).** `viewBinCount` fixed
  (`MAX_VIEW_BINS`); height resize scales the raster only (setView no-op guard). `vue-tsc` + bun 61/0.
- [x] **SF7.3 — Cache spectrograms across file switches (SF-D14).** SpectrogramSession keeps
  analyses warm as an LRU (file+params key; MAX 4 / 1.5 GB samples); reopen reuses → skips
  re-decode; close keeps warm. Contract test updated + reuse test; server 18/0. **PAUSE for owner
  UI verification.**

**Phase 13 — Settings panel: Audacity parity** *(owner addition 2026-07-04)*
- [ ] **SF13.1 — Audacity-style parameter grouping (SF-D35).** Regroup into Масштаб / Цвет /
  FFT-фильтр sections. Verify `vue-tsc` + `bun`.
- [ ] **SF13.2 — i18n for parameter values (SF-D36).** Localized dropdown option labels (en/ru).
  Verify `vue-tsc` + `bun`.
- [ ] **SF13.3 — Per-parameter help "?" (SF-D37).** Help icon + bilingual help popover per param.
  Verify `vue-tsc` + `bun`.

**Phase 12 — TSpecFft real-FFT mirror bug** *(owner addition 2026-07-04; independent of the FFTW spectrogram path)*
- [x] **SF12.1 — Diagnose + fix the TSpecFft mirror bug (SF-D34).** Root cause (vs vendored Audacity
  `RealFFTf.cpp`): C `SinTable[*br1 + 1]` (adjacent cos slot) mistranslated as Pascal
  `FSinTable[br1[1]]` (`FBitReversed[i+1]`, wrong bin) in 3 spots (forward massage cos, center-bin
  conjugate, inverse massage cos) → fixed to `br1[0]+1` / `br1^ + 1`. New dependency-free
  regression (`tests/SpectrumCoreFftTests.pas`, `scripts/build_fft_tests_x64.bat`): cosine/sine
  sweep every bin over N ∈ {256..4096} + impulse/DC/Nyquist/two-tone all clean (<0.1 % of peak).
  Fixes `SpectrumCoreStft` too. Independent of the FFTW spectrogram path → no rebundle.

**Phase 11 — i18n, caching fix, tile-generation speed** *(owner addition 2026-07-03)*
- [x] **SF11.1 — i18n for the Параметры panel (SF-D27).** Localized all field + slider labels in
  `SpectrogramSettingsPanel` (18 keys, en/ru; sliders computed for reactivity). Technical option
  values + preset names left untranslated by design. `vue-tsc` + bun 61/0.
- [x] **SF11.2 — Fix spectrogram caching across file switches (SF-D28).** Root cause: the warm
  analysis LRU worked, but Opt C's lazy STFT recomputes tiles on every `get-tile`. Added a
  per-warm-analysis server-side computed-tile cache (keyed `zoom|timeStart|timeEnd|viewBinCount`,
  LRU cap 64) so returning to a file / re-panning is instant. +mock unit test; server 31/0.
- [x] **SF11.5 — Bounded-oversample max-pool (SF-D31).** `EnsureColumnsMaxPooled` max-pools the RAW
  magnitude of K=min(Factor,32) sub-columns per output column (interpolate once per output column).
  Overview zoom=10 272ms (old full-res 3949ms, ~14×) with peak brightness restored. bridge+session
  31/0. *Owner UI verify pending.*
- [x] **SF11.9 — Responsiveness: cross-zoom tile fallback (backlog B1).** When an exact-zoom tile
  isn't cached yet, `assembleVisibleTiles` falls back to a cached covering tile from another zoom
  (rendered stretched, coarse-under-exact), so zoom/pan shows instant coarse content instead of
  blank. Client-only; `SpectrogramTileCache.findBest` + a unit test; vue-tsc + ui 63/0.
- [x] **SF11.8 — Minimap spectrogram thumbnail (backlog B7).** The bottom minimap renders a
  whole-clip spectrogram thumbnail (its own `useSpectrogram`, fixed whole-clip view; reuses the
  primary track's warm analysis + tile cache, so ~free) behind the draggable navigator. UI-only;
  `vue-tsc` + build + ui 61/0.
- [x] **SF11.7 — Shared decode for stereo (SF-D33).** 1-file decode cache in `AudioLoadChannel`
  (sndfile path): decode all channels once, hand each to its analysis, stash siblings transiently
  (memory-safe). ch1 open 2665ms → 1ms; stereo first-load decode ~8.3s → ~2.9s. bridge+session
  31/0. *Owner UI verify pending.*
- [x] **SF11.6 — Binary tile transport (SF-D32).** Tile bins as a base64 float32 blob (`binsB64`)
  instead of per-bin JSON — no `FloatToStrF`/number JSON at any hop. Worker `EncodeStringBase64`,
  server pass-through, client `atob`→Float32Array in `tileToImage`. Overview zoom=10 272→76ms
  (cumulative 3949→76ms, **~52×**). vue-tsc + server 31/0 + ui 61/0. *Owner UI verify pending.*
- [x] **SF11.4 — Audacity-style display-resolution STFT (SF-D30).** Worker computes one FFT per
  emitted column at stride `Factor=2^zoom` (via `EnsureColumns`, column-based parallel STFT) for
  zoom>0 lazy magnitude/phase modes, instead of full-res + max-pool. **Profiled: overview
  3949ms → 545ms (~7×)**; JSON emit is the new floor (backlog B4). zoom0/pitch/reassignment +
  cursor readout unchanged. Rebuilt + rebundled; bridge+session 31/0. *Owner UI verify pending.*
- [x] **SF11.3 — Profile + speed up tile generation (SF-D29).** Profiled (code analysis + SF6.1
  data): bottleneck = per-tile STFT recompute on cache miss (`EnsureRange` over the full-res
  span; overview recomputes the whole STFT). Applied win = SF11.2 server tile cache (re-views
  instant) + existing worker W3 cache. First-gen STFT already A+B+C optimized; remaining gap vs
  Audacity is architectural (persistent SpecCache). **Step 2 (owner-gated): study Audacity 3.7.8
  after owner verifies SF11.2.**

**Phase 10 — Track chrome layout (header / labels / axes / bottom selector)** *(owner addition 2026-07-02)*
- [x] **SF10.1 — Common header above the stack (SF-D21).** Shared header bar over the stack holds
  the zoom/fit buttons (once), driving the shared view; buttons removed from SpectrogramView.
  `vue-tsc` clean.
- [x] **SF10.2 — L/R labels as top-left overlays (SF-D22).** Channel label is a top-left plot
  overlay for every track (same place); toolbar label removed. `vue-tsc` clean.
- [x] **SF10.3 — Time axis top-of-first + bottom-of-last only (SF-D23).** `showTimeAxisTop/Bottom`
  props + dynamic margins; time ruler above the first and below the last track only; frequency
  axis stays per-track. `vue-tsc` clean.
- [x] **SF10.4 — Fixed bottom minimap-overview selector (SF-D24).** New `SpectrogramMinimap.vue`
  (canvas overview + draggable/resizable visible-window handle) at the bottom of the stack, driving
  the shared view; the q-range/readout toolbar removed and the readout is now a cursor tooltip
  (SF-D25). `vue-tsc` + bun 61/0. **Phase 10 complete.** *(Minimap has no spectrogram thumbnail yet
  — possible follow-up.)*
- [x] **SF10.5 — Remove the "Спектрограмма" subtitle under the transport (SF-D26).** Dropped the
  `audio.spectrogramTitle` line in the spectrogram tab. `vue-tsc` clean.

**Phase 9 — Track resize model (Audacity boundaries)** *(owner addition 2026-07-02)*
- [x] **SF9.1 — Square track corners (SF-D18).** Removed `border-radius` on `.spectrogram-view`.
  `vue-tsc` clean.
- [x] **SF9.2 — Per-track heights + 2px mutual-resize divider (SF-D19).** AudioPage owns per-track
  heights (`spectrogramTrackHeights[]`, persisted); a 2px divider between adjacent tracks trades
  height (one up / one down). SpectrogramView's own SF5.2 handle retired. `vue-tsc` + bun 61/0.
- [x] **SF9.3 — Bottom handle = uniform resize of all tracks (SF-D20).** Bottom handle below the
  last track applies the same delta to every track (clamped to [120,1200]); resize handling now
  fully in the AudioPage stack. `vue-tsc` + bun 61/0. **Phase 9 complete.**

**Phase 8 — Audacity multi-track polish** *(owner addition 2026-07-02)*
- [x] **SF8.1 — Multi-track chrome like Audacity (SF-D15).** Shared time window + area selection
  across stacked tracks (provide/inject); toolbar/icons/readout on the primary track only,
  non-primary label overlay; per-track resize handle; inter-track gap 8→1px. `vue-tsc` + bun 61/0.
  **PAUSE for manual UI verification.**
- [x] **SF8.2 — Adaptive frequency-axis tick density (SF-D16).** Freq tick count scales with plot
  height (~1/42px, clamp 3..20). `vue-tsc` + bun 61/0.
- [x] **SF8.3 — Don't auto-build on Audio-tab open (SF-D17 = option a).** Dropped `immediate` from
  the `ensureSpectrogramPrepared` watch; builds only on file click / switch to Спектрограмма.
  `vue-tsc` + bun 61/0.

**Phase 4 — Prepare spectrum on tab open**
- [x] **SF4.1 — Auto-prepare on Спектрограмма tab.** `ensureSpectrogramPrepared()` + a watch
  decode the selected local file when the Спектрограмма view opens (no buffer / not loading), so
  it prepares instead of showing the stale message; `audio.noSpectrogram` wording refreshed
  (SF-D6). `vue-tsc` clean; GnauralCore bun 56/0.

## Backlog — parked ideas (**требует последующего обсуждения**)
Ideas raised during the Phase 11 speed work that were set aside — kept here so nothing is lost.
None are committed; **each requires later discussion** and may be dropped or reshaped after the
SF11.4 (display-resolution STFT) results are verified. *(Owner request 2026-07-03.)*

- **B1 — Progressive two-level rendering (owner's idea). ✅ DONE as SF11.9 (responsiveness variant,
  2026-07-04).** The original "fast → detailed" was superseded by SF11.5 (the detailed max-pool is
  already the fast default) + SF11.6 (base64). Owner chose the responsiveness variant: instead of a
  second worker pass, the client now falls back to a cached covering tile from another zoom tier
  (e.g. the whole-clip overview / minimap tile) rendered stretched, so zoom/pan shows instant coarse
  content instead of going blank, refined as the exact-zoom tiles arrive. Client-only, no
  worker/protocol change.
- **B2 — Bounded persistent per-frame STFT cache (Audacity SpecCache-style). ❌ CLOSED as obsolete
  (2026-07-04).** Superseded by SF11.4–11.6 + SF11.2: tile compute is now fast (overview 76 ms) and
  boundary-aligned tiles already reuse across pans via the SF11.2 cache; an end-to-end profile
  showed the real first-load bottleneck is the FLAC **decode** (~2.7–5.6 s/channel), which B2 does
  not touch. Building B2 = complexity + OOM risk for ~0 gain. Real lever = SF11.7 (shared decode).
- **B3 — Detail-level setting granularity.** Fast / Balanced / High oversample levels (vs a single
  constant) for B1's refined pass. UI/UX decision, deferred.
- **B4 — Binary tile transport.** Send tiles as a float32 blob instead of JSON floats to cut
  serialize/parse for large tiles. Secondary win; revisit if JSON emit shows up as a cost after
  SF11.4 makes tiles cheaper.
- **B5 — Readout ↔ pixel consistency on deep overviews.** Decide whether the cursor readout should
  match the displayed (approximated) pixel by reading the display-res cache, vs staying exact
  full-res (current/planned — see SF-D30). Minor UX call.
- **B6 — Tile-cache tuning.** Revisit `TILE_CACHE_MAX_PER_ANALYSIS` / the memory budget once tiles
  become cheaper/smaller with SF11.4.
- **B7 — Minimap spectrogram thumbnail (SF10.4 follow-up). ✅ DONE as SF11.8 (2026-07-04).** The
  bottom minimap now renders a whole-clip spectrogram thumbnail behind the navigator.
- **B8 — Worker robustness / hardening.** The GUI-subsystem worker pops dialogs on unhandled
  exceptions and doesn't drive cleanly over a raw stdio pipe (hit during SF6.1 + SF11.3 profiling);
  consider a console-subsystem build or a global exception handler for cleaner profiling/ops.

## 6. References
- View/render: [SpectrogramView.vue](../../../GnauralCore/ui/components/SpectrogramView.vue),
  [spectrogram-render.ts](../../../GnauralCore/ui/composables/spectrogram-render.ts)
- Fetch/cache: [use-spectrogram.ts](../../../GnauralCore/ui/composables/use-spectrogram.ts),
  [spectrogram-tiles.ts](../../../GnauralCore/ui/composables/spectrogram-tiles.ts)
- Overlay pattern: [GnauralScheduleView.vue](../../../GnauralCore/ui/components/GnauralScheduleView.vue) (`settingsPanelOpen`)
- Host: [AudioPage.vue](../../../GnauralCore/ui/pages/AudioPage.vue) (spectrogram tab)
