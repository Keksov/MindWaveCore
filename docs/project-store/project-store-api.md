# Project entity — developer guide & section registry

Referenced by the binding rule in `KKMindWave/AGENTS.md` ("Per-file data: the Project entity").
Background: [project-store-plan.md](project-store-plan.md) (decisions PR-D1..D13),
ledger [project-store-progress.json](project-store-progress.json).

## What a project is

Every opened file (wav/flac/gnaural) gets a folder under the user-data root
(`%LOCALAPPDATA%\KKSoundCore` by default; configurable in editor settings):

```
<userDataRoot>/projects/<slug>-<hash8>/
  project.scp.json   — schemaVersion, kind, source fingerprint, sections{}
  undo.json          — the undo journal (separate: large, written often)
```

- Identity: sha1 of the case-folded absolute source path; renames are handled via re-link.
- Sections are **opaque, subsystem-owned JSON**; the core preserves unknown sections and unknown
  top-level fields on rewrite, so old builds never destroy new data.
- Writes are atomic (tmp+rename); corrupt files are moved aside as `*.broken-<ts>`, never lost.
- The project folder is **text-only**. Binary/cache data goes to the central cache
  (`MindWaveCore/server/tmp/` + manifest, PR-D9), never into the project folder.

## Client API (GnauralCore/ui)

`composables/use-project.ts` — everything is debounced (~500 ms per section) and flushed on file
switch and page unload (keepalive); failures never break file opening:

```ts
openProjectForFile(path)                    // called by the audio store on selection — already wired
getProjectForPath(path)                     // race-safe project resolve for subsystems
readProjectSectionFor<T>(path, name)        // null = no section (=> use editor defaults)
writeProjectSectionFor(path, name, value)   // null value deletes the section
readProjectUndoJournalFor(path)             // undo transport (byte-budget it client-side)
writeProjectUndoJournalFor(path, journal)   // 1.5 s debounce; null clears
useProject()                                // currentProject / projectOpenError refs
```

`composables/use-project-view-state.ts` — `bindProjectViewState({sectionName, filePath, view,
freqView})` wires a viewport pair to a section (register it AFTER your reset-on-file-change watch).

## Server API (MindWaveCore/server)

The `projectStore` singleton in `server.ts` (interface `ProjectStore` in `project-store.ts`):
open/list/get, get/putSection, undo transport, delete, relink, export/import. REST mirror under
`/api/projects*` (types in `SharedPasCore/ts/protocol.ts`). Server subsystems call the singleton
directly; renders that must honour project state fold it into their **cache key** (see
`voiceMuteFingerprint` in `server.ts` — a changed override must never serve a stale render).

## Section registry

One subsystem = one section. **Add a row here in the same commit that first writes the section.**

| Section        | Owner (writer)                                   | Shape                                                          | Since |
|----------------|--------------------------------------------------|----------------------------------------------------------------|-------|
| `gtrackLanes`  | gtrack lanes (`use-gtrack-lanes.ts`)             | `StoredLane[]`                                                 | PR2.1 |
| `laneSpectrum` | per-lane spectrum overrides (`use-gtrack-lanes`) | `Record<laneId, SpectrogramSettings>`                          | PR2.1 |
| `mixExcluded`  | overall-mix exclusions (`use-gtrack-lanes`)      | `number[]` (voice ids)                                         | PR2.1 |
| `waveform`     | Tracks tab display prefs (`TracksPanel.vue`)     | `{mode, scales, colors, opacities, minimap, link, both}`       | PR2.3 |
| `viewAudio`    | AudioPage spectrogram viewport                   | `{time: {startSec,endSec}\|null, freq: {lo,hi}\|null}`         | PR2.3 |
| `viewTracks`   | Tracks tab spectrogram viewport                  | same as `viewAudio`                                            | PR2.3 |
| `voiceState`   | voice colour/hidden/muted (`use-voice-state.ts`) | `Record<voiceId, {color?, hidden?, muted?}>`                   | PR2.4 |

(`undo.json` is not a section — use the undo transport.)

Naming: lowerCamelCase, `/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/`, named after the owning subsystem.

## The three canonical patterns (copy the real code)

1. **New per-file state** — write your section on change, restore on open with a request-id guard
   against fast file switches. Example: `bindProjectViewState` (PR2.3).
2. **Settings with editor defaults (PR-D13)** — the editor keeps GLOBAL defaults (localStorage);
   the section stores only the project's own values; **absent section ⇒ apply defaults, do NOT
   seed**. Example: waveform prefs in `TracksPanel.vue` (PR2.3).
3. **Migrating legacy per-file data** — localStorage stays as a transition safety net; on open,
   section-absent ⇒ one-time seed from localStorage; section-present (even empty!) ⇒ section wins.
   Example: lanes in `use-gtrack-lanes.ts` (PR2.1). For data that lived INSIDE the source file,
   seed once from the file and stop writing the file (voice-state, PR2.4).

## Hard don'ts

- No new localStorage keys keyed by file path (the pre-project pattern; the existing dual-writes
  are the sanctioned transition, do not add more).
- No writes into the SOURCE file for view/editor state (the `.gnaural` voice-state mistake —
  moved out in PR2.4).
- No ad-hoc sidecar files next to source files; per-file data lives in the project folder.
- No binaries in the project folder; caches are central so the cache UI can always enumerate them.
