# MindWaveCore

Assembled host core product.

Current ownership:

- `products/MindWaveCore/server`
- `products/MindWaveCore/ui`
- host-only composition logic that coordinates product modules

The legacy `pas/server` tree has been retired.

Host composition contract:

- Each Core UI product exposes a source-level package from its own `ui` directory; the public surface is declared in that module's `ui/package.json`.
- MindWaveCore imports only the declared `ui/module`, `ui/plugin`, and other documented subpaths instead of reaching into product-internal implementation files.
- Module descriptors contribute routes, settings tabs, and locale bundles; route contributions stay lazy by exposing `import()` loaders.
- MindWaveCore installs each module plugin with host-owned runtime services and merges module locale messages into the shared `vue-i18n` instance.
- Host-owned navigation keys remain under shell namespaces such as `nav.settings`, `nav.log`, and `nav.archive`; module-owned navigation keys stay under their own route namespaces such as `nav.monitoring` and `nav.audio`.

## Launching

MindWave launches via the shared **AppCore** WebView2 launcher (`c:\projects\Games\AppCore`).
From `server/`:

    AppMain.exe                    # auto-loads app.cfg
    AppMain.exe -config app.cfg    # explicit

- Config is [`server/app.cfg`](server/app.cfg): `Mode` (prod/dev), `ServerPort=3300`,
  `DevUrl=http://localhost:9000/`, `FullScreen`, etc.
- **prod** builds the UI (`quasar build` → `server/public`), starts the backend on `:3300`,
  and opens the webview at `http://localhost:3300/`.
- **dev** (`Mode=dev`) runs quasar dev (`:9000`) + the backend (`:3300`) with hot reload.
- Requires the Microsoft Edge **WebView2 Runtime** (preinstalled on Windows 11).
- `AppMain.exe` + `libwebview.dll` are **sync-only** (gitignored); refresh them with
  `server/sync-appcore-launcher.ps1` (copies from AppCore's prebuilt bin).
- `server/launcher.bat` remains as a no-webview fallback launcher.
