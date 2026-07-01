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
- [ ] **SF2.1 — Persist/accumulate tiles.** Instrument + fix per SF-D3 so the full spectrogram
  renders and stays; add a composable unit test for tile accumulation across view/binCount
  change. Verify `vue-tsc` + `bun`.

**Phase 3 — Settings panel overlay "Параметры"**
- [ ] **SF3.1 — Overlay + rename.** Convert the settings panel to a toggleable overlay (no
  main-content resize) titled "Параметры" with a toolbar toggle + backdrop + close; i18n en/ru.
  Verify `vue-tsc` + `bun`.

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
