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
  commitToStep,
  planUndoLogAdoption,
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
      payload: { sig: model.currentSignature, schedule: model.toScheduleWithIds() }, // BM-D2: anchors carry point ids
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

/** BM-D2/BM1.3: a restart builds the model from the FILE (fresh point ids); before adopting the
 *  log's point-form deltas the model rebases onto the anchor snapshot's ids — the same move the
 *  lanes restore performs. */
const rebaseFromAnchor = (model: GTrackModel, commits: readonly ProjectUndoLogCommit[], anchorCid: string): void => {
  const anchor = commits.find((c) => c.cid === anchorCid)!
  expect(model.rebasePointIds((anchor.payload as { schedule: GnauralScheduleData }).schedule)).toBe(true)
}

describe("S13: session round-trips over the real store", () => {
  test("edit -> save -> edit tail -> restart: undo window + redo tail reconstruct exactly", async () => {
    const dir = await makeLogDir()
    const store = createVersionLogStore()
    const fileData = fixture()

    // --- session A ---
    const modelA = new GTrackModel(fileData, [], createGTrackHistory())
    const sync = new SessionSync(store, dir, null)
    await sync.pushBaseline(modelA.savedSignature, modelA.toScheduleWithIds())

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

    // --- restart --- (adoption reads from MAIN — the ref that moves atomically with appends;
    // the VL5.2 acceptance bug was reading from the laggy head ref instead)
    store.forget(dir)
    const chain = await store.readChain(dir, { from: "main", limit: 300 })
    expect(chain.commits.length).toBe(7) // baseline + 3 deltas + save snapshot + 2 deltas

    const modelB = new GTrackModel(savedData, [], createGTrackHistory())
    const plan = planUndoLogAdoption(chain.commits, modelB.currentSignature)
    expect(plan).not.toBeNull()
    rebaseFromAnchor(modelB, chain.commits, plan!.anchorCid)
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
    await sync.pushBaseline(model.savedSignature, model.toScheduleWithIds())
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

  // S14 (v3 migration) retired at undo-legacy-removal: the client migration path is gone; the
  // pre-VL bundle `undo` field is now ignored on import (covered in project-store.test.ts).

  test("VL5.2 regression: save then EXIT (no further edits) — the window adopts from main", async () => {
    const dir = await makeLogDir()
    const store = createVersionLogStore()
    const fileData = fixture()

    // Session: edits -> Save -> exit. The save snapshot is a CHILD of the last delta, and the
    // head ref deliberately stays STALE on that delta (the debounced refs write may lose the
    // race or never fire) — exactly the owner's acceptance repro.
    const model = new GTrackModel(fileData, [], createGTrackHistory())
    const sync = new SessionSync(store, dir, null)
    await sync.pushBaseline(model.savedSignature, model.toScheduleWithIds())
    editPoint(model, 0, 210)
    editPoint(model, 1, 220)
    await sync.pushDeltas(model, 0)
    await store.putRefs(dir, { head: model.historySteps[1]!.id }) // stale: BEFORE the snapshot
    const savedData = model.toSchedule()
    await sync.pushSaveSnapshot(model)

    store.forget(dir)
    const chain = await store.readChain(dir, { from: "main", limit: 300 })
    const reopened = new GTrackModel(savedData, [], createGTrackHistory())
    const plan = planUndoLogAdoption(chain.commits, reopened.currentSignature)
    expect(plan).not.toBeNull()
    rebaseFromAnchor(reopened, chain.commits, plan!.anchorCid)
    expect(reopened.adoptUndoJournal(plan!.journal)).toBe(true)
    expect(reopened.historySteps.length).toBe(2)
    expect(reopened.historyCursor).toBe(2)
    expect(reopened.canUndo).toBe(true)
    expect(reopened.canRedo).toBe(false)

    // The head-based read (the pre-fix behaviour) really does miss the anchor — the regression
    // this test pins down.
    const headChain = await store.readChain(dir, { from: "head", limit: 300 })
    expect(planUndoLogAdoption(headChain.commits, reopened.currentSignature)).toBeNull()
  })

  test("VL5.2 regression: an unsaved last edit with a STALE head still adopts as redo from main", async () => {
    const dir = await makeLogDir()
    const store = createVersionLogStore()
    const fileData = fixture()

    const model = new GTrackModel(fileData, [], createGTrackHistory())
    const sync = new SessionSync(store, dir, null)
    await sync.pushBaseline(model.savedSignature, model.toScheduleWithIds())
    editPoint(model, 0, 210)
    await sync.pushDeltas(model, 0)
    const savedData = model.toSchedule()
    await sync.pushSaveSnapshot(model)

    // The unsaved last action: its append lands (advanceMain moves main atomically), but the
    // debounced head update is LOST (races its own append -> 404) — the owner's repro.
    editPoint(model, 1, 225)
    await sync.pushDeltas(model, 1)
    const lastActionId = model.historySteps[1]!.id

    store.forget(dir)
    const chain = await store.readChain(dir, { from: "main", limit: 300 })
    const reopened = new GTrackModel(savedData, [], createGTrackHistory())
    const plan = planUndoLogAdoption(chain.commits, reopened.currentSignature)
    expect(plan).not.toBeNull()
    rebaseFromAnchor(reopened, chain.commits, plan!.anchorCid)
    expect(reopened.adoptUndoJournal(plan!.journal)).toBe(true)
    // The last action is present — as the redo tail above the saved anchor.
    expect(reopened.historySteps.map((s) => s.id)).toContain(lastActionId)
    expect(reopened.historyCursor).toBe(1)
    expect(reopened.canRedo).toBe(true)
    expect(reopened.redo()).toBe(true)
    expect(reopened.schedule.voices[0]!.points[1]!.baseFreq).toBe(225)
  })

  test("VL5.2 round 2 regression: undo x3 -> SAVE mid-history -> restart keeps the redo tail (owner repro)", async () => {
    const dir = await makeLogDir()
    const store = createVersionLogStore()
    const fileData = fixture()

    // Session: 4 edits, undo 3 of them, Save at position 1, exit.
    const model = new GTrackModel(fileData, [], createGTrackHistory())
    const sync = new SessionSync(store, dir, null)
    await sync.pushBaseline(model.savedSignature, model.toScheduleWithIds())
    editPoint(model, 0, 210)
    editPoint(model, 1, 220)
    editPoint(model, 2, 230)
    editPoint(model, 0, 240)
    await sync.pushDeltas(model, 0)
    const tipSig = model.currentSignature
    model.undo()
    model.undo()
    model.undo()

    // The mid-history save: a SIDE snapshot off position 1, advanceMain FALSE (main must stay
    // on the line tip — hijacking it is exactly what lost the grey rows), head -> the snapshot.
    const savedData = model.toSchedule()
    const midCid = "s-mid-save"
    const parent = sync.positions[model.historyCursor]!
    const appended = await store.append(
      dir,
      [{ cid: midCid, parent, type: "snapshot", atMs: 9, payload: { sig: model.currentSignature, schedule: model.toScheduleWithIds() } }],
      { advanceMain: false },
    )
    expect(appended.rejectedFrom).toBeNull()
    await store.putRefs(dir, { head: midCid })
    expect((await store.getRefs(dir)).main).not.toBe(midCid) // main still the line tip

    // Restart: main chain has no matching anchor -> the head chain supplies the side one.
    store.forget(dir)
    const mainChain = await store.readChain(dir, { from: "main", limit: 300 })
    const reopened = new GTrackModel(savedData, [], createGTrackHistory())
    expect(planUndoLogAdoption(mainChain.commits, reopened.currentSignature)).toBeNull()

    const headChain = await store.readChain(dir, { from: "head", limit: 50 })
    const plan = planUndoLogAdoption(mainChain.commits, reopened.currentSignature, headChain.commits)
    expect(plan).not.toBeNull()
    expect(plan!.anchorCid).toBe(midCid)
    rebaseFromAnchor(reopened, headChain.commits, plan!.anchorCid)
    expect(reopened.adoptUndoJournal(plan!.journal)).toBe(true)

    // The owner's «три серые строчки»: cursor at the saved position, the redo tail alive.
    expect(reopened.historyCursor).toBe(1)
    expect(reopened.historySteps.length).toBe(4)
    expect(reopened.canRedo).toBe(true)
    expect(reopened.redo() && reopened.redo() && reopened.redo()).toBe(true)
    expect(reopened.currentSignature).toBe(tipSig)
  })

  test("BM1.4 regression: exit at an undone MIDDLE without saving — reopen restores the left-off cursor (owner repro)", async () => {
    const dir = await makeLogDir()
    const store = createVersionLogStore()
    const fileData = fixture()

    const model = new GTrackModel(fileData, [], createGTrackHistory())
    const sync = new SessionSync(store, dir, null)
    await sync.pushBaseline(model.savedSignature, model.toScheduleWithIds())
    editPoint(model, 0, 210)
    editPoint(model, 1, 220)
    editPoint(model, 2, 230)
    await sync.pushDeltas(model, 0)
    model.undo()
    model.undo() // the owner leaves at position 1 of 3…
    const midSig = model.currentSignature
    await sync.syncHead(model) // …and exits WITHOUT saving (head marks the spot)

    store.forget(dir)
    const chain = await store.readChain(dir, { from: "main", limit: 300 })
    const reopened = new GTrackModel(fileData, [], createGTrackHistory()) // file = the never-saved state
    const plan = planUndoLogAdoption(chain.commits, reopened.currentSignature)
    expect(plan).not.toBeNull()
    rebaseFromAnchor(reopened, chain.commits, plan!.anchorCid)
    expect(reopened.adoptUndoJournal(plan!.journal)).toBe(true)
    expect(reopened.historyCursor).toBe(0) // the anchor IS the baseline — nothing was ever saved

    // The lanes replay (BM1.4): the head ref points at the left-off position — walk to it.
    const headPos = plan!.positionCids.indexOf(chain.refs.head!)
    expect(headPos).toBe(1)
    while (reopened.historyCursor < headPos) expect(reopened.redo()).toBe(true)
    expect(reopened.currentSignature).toBe(midSig)
    expect(reopened.canUndo).toBe(true)
    expect(reopened.canRedo).toBe(true) // «серые» строки выше остаются доступными по Ctrl-Y
  })

  test("undo -> new edit forks the chain: the old tail survives as an orphan branch (VL-D2)", async () => {
    const dir = await makeLogDir()
    const store = createVersionLogStore()
    const fileData = fixture()

    const model = new GTrackModel(fileData, [], createGTrackHistory())
    const sync = new SessionSync(store, dir, null)
    await sync.pushBaseline(model.savedSignature, model.toScheduleWithIds())
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

  test("B9 e2e (undo-orphan-branches): the forked-off tail is listed, checkout restores it, delete removes it", async () => {
    const dir = await makeLogDir()
    const store = createVersionLogStore()
    const fileData = fixture()

    // A session: baseline + 3 edits, then undo×2 and a different edit — the log forks.
    const model = new GTrackModel(fileData, [], createGTrackHistory())
    const sync = new SessionSync(store, dir, null)
    await sync.pushBaseline(model.savedSignature, model.toScheduleWithIds())
    editPoint(model, 0, 210)
    editPoint(model, 1, 220)
    editPoint(model, 2, 230)
    await sync.pushDeltas(model, 0)
    await sync.syncHead(model)
    const abandonedTip = model.historySteps[2]!.id
    const abandonedSig = model.currentSignature

    model.undo()
    model.undo()
    editPoint(model, 0, 260)
    sync.positions.length = 2
    await sync.pushDeltas(model, 1)
    await sync.syncHead(model)

    // B1/B4: exactly one branch — the two abandoned deltas, forking off the surviving step.
    const branches = await store.listBranches(dir)
    expect(branches.length).toBe(1)
    expect(branches[0]).toMatchObject({ tip: abandonedTip, commits: 2, exclusiveCommits: 2, snapshots: 0, tags: [] })
    expect(branches[0]!.forkParent).toBe(model.historySteps[0]!.id)

    // OB-D2 (the VL5.1 checkout path): the chain from the tip crosses the fork down to the
    // baseline snapshot; replaying it restores the abandoned state signature-exact.
    const chain = await store.readChain(dir, { from: abandonedTip, untilType: "snapshot", limit: 300 })
    const anchor = chain.commits[chain.commits.length - 1]!
    expect(anchor.type).toBe("snapshot")
    const anchorPayload = anchor.payload as { sig: string; schedule: GnauralScheduleData }
    const temp = new GTrackModel(anchorPayload.schedule, [], createGTrackHistory())
    expect(temp.currentSignature).toBe(anchorPayload.sig)
    const steps = [...chain.commits]
      .reverse()
      .filter((aCommit) => aCommit.type === "delta")
      .map((aCommit) => commitToStep(aCommit)!)
    expect(temp.adoptUndoJournal({ version: 3, currentSig: temp.currentSignature, cursor: 0, steps })).toBe(true)
    while (temp.canRedo) {
      expect(temp.redo()).toBe(true)
    }
    expect(temp.currentSignature).toBe(abandonedSig)

    // B5: deleting the branch removes exactly the two abandoned commits; the line survives.
    expect(await store.deleteBranch(dir, abandonedTip)).toBe(2)
    expect(await store.listBranches(dir)).toEqual([])
    const line = await store.readChain(dir, { from: "main" })
    expect(line.commits.map((aCommit) => aCommit.cid)).toEqual([
      model.historySteps[1]!.id,
      model.historySteps[0]!.id,
      anchor.cid,
    ])
  })
})

// The chain response type flows through untouched — a compile-time reminder that the server
// stays payload-agnostic (VL-D1): nothing above ever taught it what a GTrackSchedule is.
const _typeCheck: (aCommit: ProjectUndoLogCommit) => unknown = (aCommit) => aCommit.payload
void _typeCheck
