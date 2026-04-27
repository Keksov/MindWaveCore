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

The system is now fully product-owned and self-contained.
