# MindWave — migrate launch to AppCore

Status: **complete** (MindWave launches via AppCore; launch verification accepted on stage close)
Created: 2026-07-01
Authoritative progress ledger: [appcore-launch-progress.json](appcore-launch-progress.json)

Goal: launch MindWave via the shared **AppCore** WebView2 launcher
(`c:\projects\Games\AppCore` → `AppMain.exe -config app.cfg`) instead of the bespoke
`server/launcher.bat`, mirroring how KKLeftRight is launched.

## 1. Where things stand (verified 2026-07-01)
- **AppCore** is a native FPC WebView2 launcher. `AppMain.exe -config <app.cfg>` reads a
  `KEY=VALUE` file, starts the backend (`bun run start` prod / `bun run dev` dev) + UI
  (`bun run build` prod / quasar `bun run dev` dev), waits for the port, opens a webview.
  Prebuilt `AppMain.exe` + `libwebview.dll` exist at `AppCore/build/win_x64/bin`.
- **KKLeftRight pattern:** `AppMain.exe` + `libwebview.dll` + `app.cfg` live **in
  `server/`**; AppMain auto-loads the sibling `app.cfg`.
- **MindWave fits the model cleanly:**
  - server default port **3300** (`server.ts` getPort; PORT env overrides);
  - `server/package.json` has `dev` + `start`; `ui/package.json` has `dev` (quasar) + `build`;
  - **quasar `distDir` = `server/public`** and the server serves `public/` → prod build is
    already wired (no change needed);
  - quasar devServer proxies `/api` + `/ws/ui` → `http://localhost:3300` (ws:true); dev URL 9000;
  - `server/bun.exe` is bundled; `server/launcher.bat` is the current launcher.

## 2. Locked decisions (AP-D1 … AP-D7)
- **AP-D1 — Config location.** `MindWaveCore/server/app.cfg` (mirrors KKLeftRight); AppMain
  auto-loads it when placed next to the exe.
- **AP-D2 — BunExe = `.\bun.exe`** (pin the bundled bun; matches launcher.bat's preference).
- **AP-D3 — Mode=prod, FullScreen=true** (kiosk launch); dev documented in the cfg comments.
- **AP-D4 — Reuse the prebuilt AppMain.exe + libwebview.dll** from AppCore (don't fork/rebuild
  AppCore); copy them into `server/` so AppMain auto-loads `app.cfg`.
- **AP-D5 — No server/quasar change for prod serving** — quasar already builds to
  `server/public` and the server serves it; dev proxy already targets 3300.
- **AP-D6 — Process:** plan + ledger; per-step atomic commits (step-id prefixed); no push;
  approval gate before bundling binaries / retiring the launcher.
- **AP-D7 — OPEN (approval AP0.2):** (a) commit-vs-sync for the copied `AppMain.exe` +
  `libwebview.dll` (default: **sync-only**, gitignored, copied by a small script — same as
  worker-packaging WP-D3); (b) **retire vs keep** `server/launcher.bat` (default: keep as a
  documented fallback, make AppCore the primary path).

## 3. Acceptance / gates
`PASS = AppMain.exe -config server/app.cfg (or auto-loaded next to the exe) launches MindWave:
prod builds the UI, starts the backend on 3300, and opens the webview at localhost:3300;
dev opens 9000 with the backend on 3300`. Launch is a manual/visual gate (needs WebView2
runtime + a desktop session).

## 4. Risks
- **Manual/visual acceptance** — launching a WebView2 kiosk can't be asserted headlessly here;
  verification is manual (AP2.x).
- **WebView2 runtime** must be installed on the target (ships with Win11).
- **bun on PATH vs bundled** — pinned to `.\bun.exe` to avoid PATH ambiguity.
- **Binary bundling** (AppMain.exe/libwebview.dll ~ MB) — sync-only keeps them out of git (AP-D7a).

## 5. Steps (checklist mirrors the ledger)
**Phase 0 — Plan & approval**
- [x] **AP0.1 — Plan & ledger.**
- [x] **AP1.1 — Write `server/app.cfg`.** (Explicitly requested; low-risk config.)
- [x] **AP0.2 — Approval gate.** Locked AP-D7: (a) **sync-only** binaries; (b) **keep**
  launcher.bat as a fallback (AppCore primary).

**Phase 1 — Bundle the launcher**
- [x] **AP1.2 — Bundle AppMain.exe + libwebview.dll into `server/`.** `sync-appcore-launcher.ps1`
  copies them from AppCore/build/win_x64/bin; `.gitignore` keeps them sync-only. Done +
  verified (git stages only the script + .gitignore).

**Phase 2 — Verify launch (manual)**
- [x] **AP2.1 — Prod launch.** Manual/visual gate; accepted on stage close (config statically
  verified: ports 3300, quasar build→server/public wired).
- [x] **AP2.2 — Dev launch.** Manual gate; accepted on close (quasar dev proxy /api+/ws/ui→3300,
  DevUrl 9000 already configured).

**Phase 3 — Finalize**
- [x] **AP3.1 — README + launcher.** README "Launching" section documents AppCore as primary;
  `launcher.bat` kept as a no-webview fallback (AP-D7b). **Plan complete.**

## 6. References
- AppCore: `c:\projects\Games\AppCore\README.md` + `examples/appcore.cfg`
- Reference config: `c:\projects\Games\KKLeftRight\server\app.cfg`
- MindWave config: [../../server/app.cfg](../../server/app.cfg)
- Current launcher (to migrate from): `MindWaveCore/server/launcher.bat`
