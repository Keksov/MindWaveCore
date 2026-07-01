# UI refinements batch 1

Status: **active** (batch 1 phases 1–3 done; reopened 2026-07-01 for RF4 — spectrum on file click)
Created: 2026-07-01
Authoritative progress ledger: [ui-refinements-progress.json](ui-refinements-progress.json)

Goal: three independent refinements requested by the owner —
1. remove the gap between the central page block and the program window, on **all** screens;
2. make the audio-player **presets sidebar** collapsible/slide like the "Дорожки" (Tracks)
   panel, toggled by a new **"Файлы" / "Files"** item placed left of **"Воспроизведение"**
   in the player menu;
3. fix an **AppCore** bug where the top-center control bar stays visible on top of other
   apps when the main window is sent to the background (it must hide/show with the window).

## 1. Where things stand (verified 2026-07-01)
- **Item 1 (gap).** Every page centers its content in a `<page>__inner` wrapper that carries
  `padding: 16px` (12px in the ≤960px media query). That outer padding is the gap between the
  content and the window edge. Pages in scope:
  - MindWave shell: [SettingsPage.vue](../../ui/pages/SettingsPage.vue) (`.settings-page__inner`),
    [LogPage.vue](../../ui/pages/LogPage.vue), [LogArchivePage.vue](../../ui/pages/LogArchivePage.vue)
    (`.archive-page__inner`).
  - Gnaural module: [AudioPage.vue](../../../GnauralCore/ui/pages/AudioPage.vue) (`.audio-page__inner`).
  - BodyMonitor module: `AlphaRelaxationPage.vue`, `CalibrationPage.vue`, `MonitoringPage.vue`.
  - The shell `q-page-container`/`q-layout` ([MainLayout.vue](../../ui/layouts/MainLayout.vue))
    adds no padding itself — the gap is per-page.
- **Item 2 (presets sidebar).** [AudioPage.vue](../../../GnauralCore/ui/pages/AudioPage.vue)
  renders `audio-page__sidebar` (flex `0 0 360px`) always-visible beside `audio-page__content`.
  The collapsible pattern to mirror already exists in
  [GnauralScheduleView.vue](../../../GnauralCore/ui/components/GnauralScheduleView.vue):
  `trackPanelOpen` ref + `loadStoredTrackPanelOpen`/`saveStoredTrackPanelOpen` (localStorage) +
  `toggleTrackPanel` + a `<transition>`-animated `aside` panel + a toolbar toggle button with
  `aria-expanded`/`aria-controls`. The player menu is the `activePlayerViewTab` tabs bar
  (`audio-page__player-view-tabs`) with tabs **Воспроизведение** (`audio.playbackTab`/
  `scheduleTab`, name `main`) and **Спектрограмма** (name `spectrogram`).
- **Item 3 (AppCore bar).** [AppBar.pas](../../../Games/AppCore/src/AppBar.pas) creates a
  `WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED` popup pinned to the
  top-center of the main window. `updateBar` (30 ms timer) only hides it when the main window
  is **minimized** (`IsIconic`); when the app is merely covered by other windows it stays on
  top because it is `HWND_TOPMOST`. Rebuild: `build/win_x64/build_app.bat` (stage 2, Pascal
  only; FPC at VendorsCore/fpc). AppCore is its own git repo; the built `AppMain.exe` is
  re-synced into MindWave via `server/sync-appcore-launcher.ps1` (sync-only, gitignored).

## 2. Decisions (RF-D1 … RF-D5) — locked at RF0.2
- **RF-D1 — Scope & process.** Three independent items → three phases. Per-step atomic commits
  (step-id prefixed, Co-Authored-By line); **NO push**; phase-boundary review pauses;
  `vue-tsc` + `bun` stay green for UI steps. Item 3 commits in the **AppCore** repo; the
  re-synced binary in MindWave stays gitignored (not committed).
- **RF-D2 — Gap removal.** Zero the **outer** page padding (the `<page>__inner` wrapper) on all
  in-scope pages so the central block is flush with the window; **inter-panel gaps stay**
  (e.g. `audio-page__inner` keeps its 16px `gap`, only `padding` → 0). Applies to both the
  base rule and the responsive media-query overrides.
- **RF-D3 — Presets sidebar collapse.** Reuse the Tracks-panel pattern: a `filesPanelOpen` ref
  persisted to localStorage (per-key like the tracks panel); the sidebar is toggled via plain
  `v-if` and removed from layout flow when closed — matching the Tracks panel, which uses a
  plain `v-if` (no animated transition). Default **open**. **The gap between the files panel and
  the player is 5px** — the same as the Tracks panel's `__content { gap: 5px }` (replacing the
  current `audio-page__inner { gap: 16px }`). *(Owner addition 2026-07-01: match the Tracks-panel
  spacing.)*
- **RF-D4 — "Файлы"/"Files" toggle placement.** A toggle control in the **top-level menu bar**
  (`audio-page__tabs-bar`), **left of the "Плеер" tab** (`audio.playerTab`), icon `folder`,
  label `audio.filesTab` (ru "Файлы"/en "Files"), `aria-expanded`/`aria-controls`, active
  styling when open. It toggles the shared `filesPanelOpen` state. Placing it at the top level
  (rather than inside the player menu) matches the fact that the presets sidebar is shared by
  both the Плеер and Редактор tabs. *(Owner clarification 2026-07-01: top-level menu, left of
  "Плеер" — not the player-view submenu.)*
- **RF-D5 — AppCore fix.** In `updateBar`, hide the bar when the main window is **not the
  foreground app** (occluded/behind other windows) in addition to when it is minimized; show
  it when the main app returns to the foreground. Detect via the foreground window's root/owner
  identity (`GetForegroundWindow` + `GetAncestor(..., GA_ROOTOWNER)`), counting the bar itself
  (`WS_EX_NOACTIVATE`, so it never steals foreground) as "app active".
- **RF-D6 — Start-button edge offset (audio player).** After RF1.1 the embedded gnaural
  schedule toolbar (`output-section--schedule`, padding 0) leaves the Start button flush to the
  window/card edge. Give the schedule toolbar horizontal padding (**16px**, the app's standard
  unit ≈ the effective inset of the top menu items) so the Start button gets the same edge
  offset as the top menu; the canvas below stays full-bleed. Standalone player + spectrogram
  toolbars already sit at 16px. *(Owner addition 2026-07-01.)*
- **RF-D7 — Files-panel close button.** Add a close (×) button to the files panel header,
  mirroring the Tracks panel header (`q-btn flat round dense icon="close"` → `closeFilesPanel`).
  *(Owner addition 2026-07-01.)*
- **RF-D8 — Show the spectrum on audio-file click.** Today `spectrogramBuffer` is decoded only
  on playback start (`ensureLocalAudioReady`), so selecting a file shows "no spectrogram" until
  you press play. Export `ensureLocalAudioReady` from the audio store and, in AudioPage
  `handleSelectedPathChange`, on a **non-autoplay** selection of a **local audio file (wav/flac)**
  set `activeContentTab = 'player'` + `activePlayerViewTab = 'spectrogram'` and trigger the
  decode so the spectrum renders without playback. **Scope: wav/flac only**; `.gnaural` keeps the
  schedule view (rendering a gnaural to WAV for its spectrum is out of scope here). *(Owner
  addition 2026-07-01.)*

## 3. Acceptance / gates
- Item 1: on every in-scope page the content card touches the window edge (no outer margin);
  `vue-tsc` clean.
- Item 2: the "Файлы"/"Files" toggle sits left of "Воспроизведение"; clicking it slides the
  presets sidebar in/out; state persists across reloads; en/ru labels present; `vue-tsc` +
  `bun` green.
- Item 3: with the app behind another window the control bar is hidden; bringing the app
  forward shows it; minimized still hides it; AppCore builds; `AppMain.exe` re-synced.

## 4. Risks
- **Visual/manual acceptance** (items 1 & 3 in particular) — layout and window-occlusion
  behaviour are visual gates the owner confirms; static checks (tsc/build) are the automated part.
- **Shared sidebar state** — the presets sidebar is shared by player+editor tabs; toggling it
  from the player menu also affects the editor tab (accepted per RF-D4).
- **AppCore toolchain** — stage-2 build needs FPC reachable; if unavailable, RF3 pauses at the
  build step (source edit still committed).

## 5. Steps (checklist mirrors the ledger)
**Phase 0 — Plan & approval**
- [x] **RF0.1 — Plan & ledger.**
- [x] **RF0.2 — Approval gate.** Owner approved (RF-D4 revised to top-level menu, left of "Плеер").

**Phase 1 — Remove the outer page gap (all screens)**
- [x] **RF1.1 — Zero outer page padding.** Zeroed `<page>__inner` padding (base + media queries)
  on SettingsPage/LogArchivePage/AudioPage (kept inter-panel `gap`) and dropped the q-page
  `padding` prop on LogPage + the three BodyMonitor pages. `vue-tsc` clean.

**Phase 2 — Collapsible presets sidebar + "Файлы" toggle**
- [ ] **RF2.1 — Make the presets sidebar collapsible + add the toggle.** In AudioPage: add
  `filesPanelOpen` (localStorage-persisted), hide the sidebar via plain `v-if` when closed
  (matching the Tracks panel), set the files↔player gap to **5px** (same as the Tracks panel),
  and add a `folder`/"Файлы" toggle in the top-level menu bar left of the "Плеер" tab; add
  `audio.filesTab` (+ show/hide aria labels) to GnauralCore i18n en/ru. Verify `vue-tsc` + `bun`.
  **Done** (vue-tsc clean; GnauralCore bun 56/0).
- [x] **RF2.2 — Start-button offset + files-panel close button.** Added `padding: 0 16px` to the
  embedded gnaural schedule toolbar so the Start button matches the top menu's edge offset
  (RF-D6); added a Tracks-style close (×) button to the files panel header → `closeFilesPanel`
  (RF-D7). `vue-tsc` clean; GnauralCore bun 56/0.

**Phase 3 — AppCore control-bar occlusion fix**
- [x] **RF3.1 — Hide the bar with the main window's foreground state.** Added
  `mainWindowIsActive` (foreground root-owner check) + updated `updateBar` guard in AppBar.pas;
  built AppCore (`build_app.bat` OK); committed in the AppCore repo; re-synced `AppMain.exe`
  into MindWave (sync-only, gitignored).

**Batch 1 (Phases 1–3) landed**; automated checks (vue-tsc, bun, FPC build) green. Manual/visual
acceptance (page layout flush with the window; sidebar collapse; Start offset; bar hides when
backgrounded) is the owner's gate.

**Phase 4 — Show spectrum on audio-file click** *(reopened 2026-07-01)*
- [ ] **RF4.1 — Decode + show spectrum on selection.** Export `ensureLocalAudioReady`; in
  AudioPage `handleSelectedPathChange`, on a non-autoplay wav/flac selection switch to the
  player's Spectrogram view and decode so the spectrum shows without playback (RF-D8). Verify
  `vue-tsc` + `bun`.

## 6. References
- Collapsible pattern: [GnauralScheduleView.vue](../../../GnauralCore/ui/components/GnauralScheduleView.vue) (`trackPanelOpen`)
- Presets sidebar host: [AudioPage.vue](../../../GnauralCore/ui/pages/AudioPage.vue)
- Shell layout: [MainLayout.vue](../../ui/layouts/MainLayout.vue)
- AppCore control bar: [AppBar.pas](../../../Games/AppCore/src/AppBar.pas)
- AppCore build: `Games/AppCore/build/win_x64/build_app.bat`; re-sync: `server/sync-appcore-launcher.ps1`
