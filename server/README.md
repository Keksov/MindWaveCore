# MindWaveCore Server

This directory is now the complete home for the MindWave core host server.

Current architecture:
- **Server source:** Lives here (server.ts and all server modules)
- **Package manifest:** Owned by this directory (package.json)
- **TypeScript config:** Owned by this directory (tsconfig.json)
- **Bun runtime:** Lives here (bun.exe, bunx.exe, bun.lock)
- **Dependencies:** Installed here (node_modules/)
- **Build output:** Generated here (public/)
- **Runtime log database:** Stored here (var/)
- **Runtime caches:** Stored here (tmp/)

Runtime protocol notes:
- Compact runtime JSONL schema: `RUNTIME_JSONL_SCHEMA.md`

Development workflow notes:
- After changing **UI files only** (`ui/`): run `bun run build` in `ui/` — the server serves `public/` as static files and picks up the new build automatically. No restart needed.
- After changing **server files** (`server/*.ts`): restart is required — either via `POST /api/admin/bun-actions/restart-bun` or by relaunching `launcher.bat`.

The system is now fully product-owned and self-contained.
