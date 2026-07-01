# UI refinements batch 1

Status: **active** (plan written; approval gate RF0.2 before execution)
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
  persisted to localStorage (per-key like the tracks panel), a slide `<transition>`, and the
  sidebar removed from layout flow when closed. Default **open**.
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
- [ ] **RF0.2 — Approval gate.** Owner confirms RF-D2 (padding→0, keep inter-panel gaps),
  RF-D4 (toggle = button left of Воспроизведение), RF-D5 (foreground-based hide). PAUSE.

**Phase 1 — Remove the outer page gap (all screens)**
- [ ] **RF1.1 — Zero outer page padding.** Set the `<page>__inner` padding to 0 (base + media
  queries) across SettingsPage, LogPage, LogArchivePage, AudioPage, and the three BodyMonitor
  pages; keep inter-panel `gap`. Verify `vue-tsc`.

**Phase 2 — Collapsible presets sidebar + "Файлы" toggle**
- [ ] **RF2.1 — Make the presets sidebar collapsible + add the toggle.** In AudioPage: add
  `filesPanelOpen` (localStorage-persisted), a slide transition, hide the sidebar when closed,
  and a `folder`/"Файлы" toggle in the top-level menu bar left of the "Плеер" tab; add
  `audio.filesTab` (+ show/hide aria labels) to GnauralCore i18n en/ru. Verify `vue-tsc` + `bun`.

**Phase 3 — AppCore control-bar occlusion fix**
- [ ] **RF3.1 — Hide the bar with the main window's foreground state.** Edit AppBar.pas
  `updateBar` (+ helper) per RF-D5; build AppCore (`build_app.bat`); commit in the AppCore
  repo; re-sync `AppMain.exe` into MindWave (`server/sync-appcore-launcher.ps1`, sync-only).

## 6. References
- Collapsible pattern: [GnauralScheduleView.vue](../../../GnauralCore/ui/components/GnauralScheduleView.vue) (`trackPanelOpen`)
- Presets sidebar host: [AudioPage.vue](../../../GnauralCore/ui/pages/AudioPage.vue)
- Shell layout: [MainLayout.vue](../../ui/layouts/MainLayout.vue)
- AppCore control bar: [AppBar.pas](../../../Games/AppCore/src/AppBar.pas)
- AppCore build: `Games/AppCore/build/win_x64/build_app.bat`; re-sync: `server/sync-appcore-launcher.ps1`
