// VL4.3 (plan docs/undo-versioned-log): the S13 end-to-end conformance — scripted "sessions" of
// the REAL GTrackModel + the REAL adoption/migration planners over the REAL version-log-store,
// no UI and no owner in the loop (VL-D7). Each session mimics what the lanes sync engine does:
// baseline snapshot -> deltas -> save snapshot -> head ref; a "restart" is a fresh store
// instance + a fresh model built from the saved file data.
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import type { GnauralScheduleData, GnauralScheduleEntry, ProjectUndoLogCommit, ProjectUndoLogCommitInput } from "./protocol"
import {
  GTrackModel,
  createGTrackHistory,
} from "../../GnauralCore/ui/composables/gtrack-model"
import {
  planUndoLogAdoption,
  planV3Migration,
  stepToCommitInput,
} from "../../GnauralCore/ui/composables/undo-log-adoption"
import { createVersionLogStore, type VersionLogStore } from "./version-log-store"

const fixtureRoots: string[] = []
const makeLogDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "version-log-e2e-"))
  fixtureRoots.push(root)
  return join(root, "undo-log")
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(fixtureRoots.splice(0).map((aRoot) => rm(aRoot, { recursive: true, force: true }).catch(() => undefined)))
})

const entry = (startSec: number, endSec: number): GnauralScheduleEntry => {
  return {
    startSec,
    endSec,
    durationSec: endSec - startSec,
    baseFreqStart: 200,
    baseFreqEnd: 200,
    beatFreqHalfStart: 5,
    beatFreqHalfEnd: 5,
    volLStart: 1,
    volLEnd: 1,
    volRStart: 1,
    volREnd: 1,
  }
}

const fixture = (): GnauralScheduleData => {
  const entries = [entry(0, 10), entry(10, 25)]
  return {
    title: "T",
    author: "A",
    description: "D",
    totalTimeSec: 25,
    loopCount: 1,
    overallVolL: 1,
    overallVolR: 1,
    stereoSwap: false,
    voiceCount: 1,
    voices: [
      {
        id: 7,
        type: "tone",
        typeIndex: 0,
        description: "voice",
        hidden: false,
        muted: false,
        mono: false,
        color: "#abcdef",
        audioFilePath: "",
        totalDurationSec: 25,
        entryCount: entries.length,
        entries,
      },
    ],
  }
}

/** A minimal reimplementation of the lanes sync engine's WIRE behaviour (positions + parents),
 *  kept deliberately tiny: the point of this suite is the store<->model contract, not Vue. */
class SessionSync {
  public positions: (string | null)[] = [null]
  private snapshotSeq = 0

  public constructor(
    private readonly store: VersionLogStore,
    private readonly dir: string,
    private mainTip: string | null,
  ) {}

  public async pushBaseline(sig: string, schedule: unknown): Promise<string> {
    const cid = `s-base-${(this.snapshotSeq += 1)}`
    const commit: ProjectUndoLogCommitInput = {
      cid,
      parent: this.mainTip,
      type: "snapshot",
      atMs: 1,
      payload: { sig, schedule },
    }
    this.positions[0] = cid
    await this.appendOk([commit])
    return cid
  }

  public async pushDeltas(model: GTrackModel, aFromPosition: number): Promise<void> {
    const steps = model.historySteps
    const batch: ProjectUndoLogCommitInput[] = []
    for (let i = aFromPosition; i < steps.length; i += 1) {
      const step = steps[i]!
      batch.push(stepToCommitInput(step, this.positions[i]!))
      this.positions[i + 1] = step.id
    }
    await this.appendOk(batch)
  }

  public async pushSaveSnapshot(model: GTrackModel): Promise<string> {
    const position = model.historyCursor
    const cid = `s-save-${(this.snapshotSeq += 1)}`
    const commit: ProjectUndoLogCommitInput = {
      cid,
      parent: this.positions[position]!,
      type: "snapshot",
      atMs: 2,
      payload: { sig: model.currentSignature, schedule: model.toSchedule() },
    }
    this.positions[position] = cid
    await this.appendOk([commit])
    return cid
  }

  public async syncHead(model: GTrackModel): Promise<void> {
    const head = this.positions[model.historyCursor]
    if (head != null) {
      await this.store.putRefs(this.dir, { head })
    }
  }

  private async appendOk(aBatch: ProjectUndoLogCommitInput[]): Promise<void> {
    const result = await this.store.append(this.dir, aBatch, { advanceMain: true })
    expect(result.rejectedFrom).toBeNull()
    this.mainTip = null // parents come from positions once the chain exists
  }
}

const editPoint = (model: GTrackModel, index: number, value: number): void => {
  model.edit(() => model.setPointField(7, index, "baseFreq", value))
}

describe("S13: session round-trips over the real store", () => {
  test("edit -> save -> edit tail -> restart: undo window + redo tail reconstruct exactly", async () => {
    const dir = await makeLogDir()
    const store = createVersionLogStore()
    const fileData = fixture()

    // --- session A ---
    const modelA = new GTrackModel(fileData, [], createGTrackHistory())
    const sync = new SessionSync(store, dir, null)
    await sync.pushBaseline(modelA.savedSignature, fileData)

    editPoint(modelA, 0, 210)
    editPoint(modelA, 1, 220)
    editPoint(modelA, 2, 230)
    await sync.pushDeltas(modelA, 0)

    // Save: the file now equals the edited state; snapshot it at cursor 3.
    const savedData = modelA.toSchedule()
    const savedSig = modelA.currentSignature
    await sync.pushSaveSnapshot(modelA)

    // Two more UNSAVED edits — the tail the exit will lose from the file but not from the log.
    editPoint(modelA, 0, 215)
    editPoint(modelA, 1, 225)
    const finalSig = modelA.currentSignature
    await sync.pushDeltas(modelA, 3)
    await sync.syncHead(modelA)

    // --- restart ---
    store.forget(dir)
    const chain = await store.readChain(dir, { from: "head", limit: 300 })
    expect(chain.commits.length).toBe(7) // baseline + 3 deltas + save snapshot + 2 deltas

    const modelB = new GTrackModel(savedData, [], createGTrackHistory())
    const plan = planUndoLogAdoption(chain.commits, modelB.currentSignature)
    expect(plan).not.toBeNull()
    expect(modelB.adoptUndoJournal(plan!.journal)).toBe(true)

    // The window: 3 undo steps below the anchor, 2 redo steps above it (the unsaved tail).
    expect(modelB.historyCursor).toBe(3)
    expect(modelB.historySteps.length).toBe(5)
    expect(modelB.canUndo).toBe(true)
    expect(modelB.canRedo).toBe(true)

    // Redo the unsaved tail: the reconstructed state must equal session A's final state.
    expect(modelB.redo()).toBe(true)
    expect(modelB.redo()).toBe(true)
    expect(modelB.currentSignature).toBe(finalSig)

    // Undo all the way down: the baseline state is reachable too.
    while (modelB.canUndo) modelB.undo()
    expect(modelB.currentSignature).toBe(new GTrackModel(fileData, [], createGTrackHistory()).currentSignature)

    // Undo/redo across sessions moved ONLY the head ref — no commits were added.
    expect((await store.stats(dir)).commits).toBe(7)
    expect(savedSig).toBe(plan!.journal.currentSig)
  })

  test("checkout: a snapshot payload rebuilds the exact saved state", async () => {
    const dir = await makeLogDir()
    const store = createVersionLogStore()
    const fileData = fixture()

    const model = new GTrackModel(fileData, [], createGTrackHistory())
    const sync = new SessionSync(store, dir, null)
    await sync.pushBaseline(model.savedSignature, fileData)
    editPoint(model, 0, 300)
    await sync.pushDeltas(model, 0)
    const saveCid = await sync.pushSaveSnapshot(model)
    const savedSig = model.currentSignature

    // Later: fetch the snapshot commit and rebuild a model from its payload (the checkout core).
    store.forget(dir)
    const chain = await store.readChain(dir, { from: saveCid, limit: 1 })
    const snapshot = chain.commits[0]!
    const payload = snapshot.payload as { sig: string; schedule: GnauralScheduleData }
    const restored = new GTrackModel(payload.schedule, [], createGTrackHistory())
    expect(restored.currentSignature).toBe(payload.sig)
    expect(payload.sig).toBe(savedSig)
  })

  test("S14 e2e: v3 migration replays into an empty log once; a re-run changes nothing", async () => {
    const dir = await makeLogDir()
    const store = createVersionLogStore()
    const fileData = fixture()

    // A legacy session: 3 edits, one undo — the exported v3 journal has cursor 2 of 3.
    const legacyModel = new GTrackModel(fileData, [], createGTrackHistory())
    editPoint(legacyModel, 0, 210)
    editPoint(legacyModel, 1, 220)
    editPoint(legacyModel, 2, 230)
    legacyModel.undo()
    const legacy = legacyModel.exportUndoJournal()
    const legacyFileData = legacyModel.toSchedule() // undo.json chains to the CURRENT (cursor) state

    // Restart into the new world: empty log -> migrate.
    const model = new GTrackModel(legacyFileData, [], createGTrackHistory())
    expect(model.adoptUndoJournal(legacy)).toBe(true)
    const plan = planV3Migration(legacy, legacyFileData, 5_000)
    const first = await store.append(dir, plan.commits, { advanceMain: true })
    expect(first.rejectedFrom).toBeNull()
    expect(first.appended).toBe(plan.commits.length)

    // The migrated window survives the NEXT restart through the normal adoption path.
    store.forget(dir)
    const chain = await store.readChain(dir, { from: "main", limit: 300 })
    const model2 = new GTrackModel(legacyFileData, [], createGTrackHistory())
    const adoption = planUndoLogAdoption(chain.commits, model2.currentSignature)
    expect(adoption).not.toBeNull()
    expect(model2.adoptUndoJournal(adoption!.journal)).toBe(true)
    expect(model2.historyCursor).toBe(2)
    expect(model2.historySteps.length).toBe(3)
    expect(model2.canRedo).toBe(true) // the undone step came back as redo

    // Double-run safety (S2/S14): replaying the same migration is a pure no-op.
    const second = await store.append(dir, plan.commits, { advanceMain: true })
    expect(second.appended).toBe(0)
    expect(second.skipped).toBe(plan.commits.length)
    expect((await store.stats(dir)).commits).toBe(plan.commits.length)
  })

  test("undo -> new edit forks the chain: the old tail survives as an orphan branch (VL-D2)", async () => {
    const dir = await makeLogDir()
    const store = createVersionLogStore()
    const fileData = fixture()

    const model = new GTrackModel(fileData, [], createGTrackHistory())
    const sync = new SessionSync(store, dir, null)
    await sync.pushBaseline(model.savedSignature, fileData)
    editPoint(model, 0, 210)
    editPoint(model, 1, 220)
    await sync.pushDeltas(model, 0)
    const abandonedCid = model.historySteps[1]!.id

    // Undo the last edit, then edit differently: the model truncates its window, the LOG forks.
    model.undo()
    editPoint(model, 2, 240)
    // the lanes diff: common prefix = 1 -> positions truncated, the new delta chains onto step 1
    sync.positions.length = 2
    await sync.pushDeltas(model, 1)
    await sync.syncHead(model)

    const stats = await store.stats(dir)
    expect(stats.commits).toBe(4) // baseline + 2 deltas + 1 fork delta (nothing deleted)
    expect(stats.orphans).toBe(1) // the abandoned step

    // The orphan is still readable by cid — history is genuinely never lost (until GC).
    const orphanChain = await store.readChain(dir, { from: abandonedCid, limit: 1 })
    expect(orphanChain.commits[0]!.cid).toBe(abandonedCid)
  })
})

// The chain response type flows through untouched — a compile-time reminder that the server
// stays payload-agnostic (VL-D1): nothing above ever taught it what a GTrackSchedule is.
const _typeCheck: (aCommit: ProjectUndoLogCommit) => unknown = (aCommit) => aCommit.payload
void _typeCheck
