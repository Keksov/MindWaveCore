# GT5.1 — Wave ↔ XML synchronization: design + owner Q&A

**Status:** DESIGN ONLY. Per GT-D7, no code is written until a separate owner "go" after this
document is reviewed and the open questions (§6) are answered. This is the deliverable of GT5.1.

Owner requirement (req. 8): *«режим синхронизации между волновым и XML представлениями»* — a
"synchronization mode" between the waveform and the XML representations.

---

## 1. The three representations of a `.gnaural`

There are **three** views of the same file, not two. Being precise about which pair syncs (and in
which direction) is the whole point of this document.

| # | Representation | Where | Editable? | Derivation |
|---|---|---|---|---|
| **A** | **Raw XML text** | old «Редактор» tab (CodeMirror) | yes (free-form text) | the source of truth on disk |
| **B** | **Schedule / curves** | new gtrack editor (points, Base/Beat/Volume/Balance) | yes (drag / dialog / add / delete) | XML → `--dump-schedule` → points (GT1.1); points → XML via the surgical patcher (GT-D5) |
| **C** | **Rendered wave / spectrum** | wave + spectrogram lanes | **no** (it is audio samples) | XML → `Gnaural.exe` render → WAV → worker STFT/peaks |

Key facts that constrain any design:

- **A ↔ B is a lossy, structured round-trip.** The dump *expands* generator (`preparse`) nodes and
  drops fields it doesn't emit (wave types, phases, unknown tags). The GT-D5 patcher only rewrites
  each edited voice's `<entries>`, preserving everything else — so **B → A is safe and surgical**,
  but **A → B (re-parsing arbitrary hand-edited XML into curves) requires a full re-dump** (a
  `Gnaural.exe` round-trip), not a cheap client parse.
- **C is a pure output.** You cannot recover a schedule from arbitrary audio samples. **"Wave → XML"
  in the literal sense is infeasible.** Any "editing on the wave" must actually edit **B** (the
  schedule) through a direct-manipulation gesture, then re-render C — it is B ↔ C, dressed up.

So the literal phrase "wave ↔ XML" resolves to **two tractable sync problems** plus one impossible
one:

1. **B ↔ A** — curve editor ↔ raw XML text (two editable views of the schedule).
2. **B → C** — schedule → rendered wave/spectrum (already one-directional on Save; the question is
   *how live*).
3. ~~C → B/A~~ — impossible for real audio; only a **constrained direct-manipulation** gesture on the
   wave/spectrum that edits B is meaningful (e.g. drag a volume envelope drawn over the waveform).

---

## 2. What "synchronization mode" could mean (interpretations)

The owner req is a **mode**; here are the candidate behaviours it could switch on. They are not
mutually exclusive — the owner may want a subset.

- **I1 — Live B → C re-render.** While you edit curves, the wave + spectrum update automatically
  (debounced), instead of only on Save. "The wave always reflects the current schedule."
- **I2 — Live B ↔ A text sync.** Show the raw XML alongside the curves; editing curves updates the
  XML text live, and (optionally) editing the XML text updates the curves live.
- **I3 — Direct manipulation on C.** Draw/drag directly on the waveform or spectrogram lane to edit
  the schedule (B) — e.g. dragging the volume envelope, or "painting" a base-frequency line on the
  spectrogram — then re-render.
- **I4 — Save-time only (status quo, GT-D3).** No live mode; B → A on Save (patch+validate), then
  invalidate + re-render C. Already implemented (GT3.4). "Sync" = the Save button + dirty flag.

---

## 3. Feasibility + cost of each interpretation

**I1 — live re-render (B → C).**
- Feasibility: straightforward mechanically (we already render on Save). The cost is the **render +
  analysis latency**: `Gnaural.exe` renders the whole file to WAV, then the worker STFTs it. For a
  20-minute preset (ForestMeditation) that is seconds, not milliseconds — far too slow for
  keystroke-live. Viable only **debounced on edit-pause** (e.g. 800 ms idle), and even then heavy.
- Mitigations: render only the **visible time window**, or only the **edited voice(s)** (solo
  render, GT4.3 machinery already exists), or gate it behind an explicit "re-render now" affordance.
- UX risk: a long file makes the app feel busy; needs a clear "stale / rendering" indicator.

**I2 — live B ↔ A text.**
- **B → A (curves → XML text):** cheap and safe — it is the GT-D5 patcher run in-memory on every
  commit; just display the patched XML. No `Gnaural.exe` needed.
- **A → B (XML text → curves):** **expensive and fragile.** Re-parsing needs a real
  `--dump-schedule` (to expand generators, validate, and get authoritative values), i.e. a
  round-trip per edit. Hand-edited XML may be invalid mid-typing. Practical only **debounced +
  validated**, or one-shot ("apply XML → rebuild curves").
- Conflict: if both the curve editor and the XML text are edited, which wins? (see §5).

**I3 — direct manipulation on the wave/spectrum.**
- **Volume envelope on the waveform:** feasible and natural — it maps to editing `volL/volR` points
  of a voice, the same model ops the curve lane already uses. But *which* voice, when the wave is a
  **mix** of all voices? Only unambiguous for a **solo** wave (GT4.3) — i.e. edit the envelope of the
  one soloed voice.
- **"Painting" base frequency on the spectrogram:** seductive but hard — the spectrogram is a mix;
  there is no reliable inverse from a painted line to a specific voice's `basefreq` schedule, and
  quantizing a freehand line into entries is its own design. High effort, unclear payoff.
- Verdict: a **solo-lane volume-envelope drag** is the only tractable, valuable slice of I3.

**I4 — status quo.** Already done. Zero new cost. The baseline we improve on.

---

## 4. Recommendation (for discussion, not decided)

A phased path that front-loads value and defers the expensive/fragile parts:

1. **I1-lite first:** an **auto-re-render toggle** (off by default) that, when on, re-renders the
   wave/spectrum on edit-pause — scoped to the **visible window** and/or **edited voice** to keep it
   affordable. This is the smallest thing that makes "the wave follows my edits" real. Builds
   directly on GT3.4 (Save) + GT4.3 (solo render).
2. **I2 B→A read-only view:** show the live patched XML next to the curves (cheap, safe, useful for
   trust/debugging). **Defer A→B** (editable XML that rebuilds curves) until there is demand — it is
   where most of the conflict/validation complexity lives.
3. **I3 solo-envelope drag:** only if the owner wants direct manipulation; scope strictly to the
   soloed voice's volume envelope.

This ordering means **no bidirectional-conflict problem in phase 1** (B is the single source; A and
C are projections of it), which sidesteps §5 entirely until we deliberately opt into A→B or I3.

---

## 5. Cross-cutting decisions (the hard parts the owner must weigh in on)

These are the "двунаправленность / конфликтные правки / гранулярность" the plan calls out.

- **Bidirectionality.** Is B the single source of truth (A and C are always *projections* of B), or
  are A and B *co-equal* editable views that must reconcile? Single-source is dramatically simpler
  and avoids all conflict logic; co-equal is more powerful but needs a merge/conflict story.
- **Conflict handling** (only if co-equal): last-writer-wins? lock one view while the other is
  focused? a visible "diverged — choose A or B" prompt? What about the file changing **on disk**
  (external edit) mid-session — the Save path already 409s on mtime mismatch (GT3.4); does live sync
  need the same guard?
- **Granularity / cadence.** When does a sync fire: on **every edit** (keystroke/drag-tick), on
  **edit-pause** (debounced), or only on **explicit apply/Save**? This trades immediacy vs cost
  (esp. for the `Gnaural.exe` round-trips in A→B and B→C).
- **Scope of re-render (B→C).** Whole file, visible window only, or edited-voice solo? (Directly
  drives whether live re-render is usable on long presets.)
- **Preparse voices.** Live A→B on a file with generator nodes re-expands them each parse; how does
  that interact with the "fix / make editable" lock (GT-D9)?

---

## 6. Open questions for the owner (answers drive the build plan)

1. **What does "wave" mean in "wave ↔ XML"?** The rendered audio (C), or is it shorthand for the
   visual curve/schedule editor (B)? (This alone changes everything.)
2. **Which interpretations do you want** — I1 (live re-render), I2 (live XML text), I3 (draw on the
   wave), or just a better I4? (Pick any subset.)
3. **Single source of truth (B), or co-equal A ↔ B** that must reconcile?
4. **Sync cadence:** live-on-pause, or explicit apply/Save?
5. **For live re-render:** acceptable to scope it to the **visible window / soloed voice** so long
   presets stay responsive?
6. **Is editable raw-XML-that-rebuilds-curves (A→B) actually wanted**, or is a **read-only** live XML
   view enough?

---

## 7. Answers (owner Q&A, 2026-07-11)

1. **What to sync:** **I1 (live re-render)** + a **constrained I3** — NOT free-hand painting.
   Owner's exact I3: *"простой режим, когда можно рисовать две точки и между ними будет построена
   базовая частота с указанной частотой и длительностью; пользователь потом сам руками подправит
   beat freq."* → a **two-point base-frequency tool** on the spectrogram: click two points; a base-
   freq line/segment is built between them (frequency from the clicked position, duration from the
   time span); the user then hand-adjusts beat freq. **I2 (live raw-XML text) is NOT wanted. I4 is
   superseded by I1.**
2. **Source of truth:** **Curves (B) — single source.** XML + wave are always projections. → **no
   conflict/merge logic at all** (§5 bidirectionality/conflict questions are moot). Big simplifier.
3. **Cadence:** **try BOTH** auto-on-pause and explicit. Owner adds a crucial idea: a **"pointwise /
   partial sync" mode** that does **not** regenerate everything — only the **affected schedule
   fragments**. This is a research point (see the plan) because `Gnaural.exe` renders the whole file.
4. **Live-render scope:** **visible window / soloed voice** (so long presets stay responsive).

## 8. Resulting build plan (Phase 5 code — starts only after a separate "go")

B is the single source of truth, so every sync below is a **projection of B** — no merge logic.

- **GT5.2 — Live re-render (I1).** A toggle that, on edit-pause (debounced) and/or an explicit
  button, re-renders the wave + spectrum from the current schedule, **scoped to the visible window /
  edited (soloed) voice** (reuse GT3.4's render path + GT4.3 solo render). A visible
  "stale / rendering" indicator. Evaluate both cadences (auto-on-pause vs explicit) against real
  presets. Renders from the **in-memory** schedule (no Save required) via a temp `.gnaural`.
- **GT5.3 — Pointwise / partial sync (research + impl).** Avoid whole-file regeneration; re-render/
  re-analyze only the affected fragment. **Open question — `Gnaural.exe` has no partial-render flag**,
  so options to investigate: (a) render a temp schedule **truncated to the affected time window**
  (fabricate a sub-schedule, offset back); (b) whole-file WAV render but **re-analyze only the
  changed STFT frames** on the worker (the render is the bottleneck, so this only helps analysis);
  (c) accept a debounced whole-file render under the GT5.2 scope as the pragmatic v1. Pick after a
  spike measuring render time vs window length.
- **GT5.4 — Two-point base-frequency tool (constrained I3).** A point-mode tool: pick a **target
  voice**, click two points on the **spectrogram**; map the clicked Y → base frequency (via the
  spectrogram's frequency axis) and the X span → a time segment; add/set the voice's **base-freq**
  points (model op on B, one undo unit) so the segment ramps/holds that frequency over that
  duration; the user then adjusts **beat freq** manually in the curve editor. Then re-render (GT5.2).
  Scope: base-freq only (beat/volume stay manual), single target voice (the spectrogram is a mix).

Ordering: GT5.2 first (makes "the wave follows my edits" real, reuses existing machinery), then GT5.4
(direct-manipulation authoring), then GT5.3 (perf optimization, only if whole-file proves too slow).
