import { mkdir, rename, stat, unlink } from "node:fs/promises"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import type { Server, Subprocess } from "bun"
import { XMLParser, XMLBuilder } from "fast-xml-parser"
import { createSession, type AppSession } from "../../BodyMonitorCore/server"
import {
  buildInlineContentDisposition,
  createGnauralEditorStore,
  createGnauralSession,
  getAudioFileKind,
  isGnauralEditorStoreError,
  resolveGnauralExecutablePath,
  resolveAllowedAudioFilePath,
  type GnauralSession,
} from "../../GnauralCore/server"
import { AudioCacheManifest } from "./audio-cache-manifest"
import { getAudioOutputCachePath, gnauralContentFingerprint } from "./audio-cache-key"
import { createFsProviderRegistry } from "./fs-browser-provider"
import { createLocalFsProvider } from "./fs-browser-local"
import { startFsBrowserServer, isLoopbackAddress, ensureLoopbackNoProxy, type FsBrowserServer } from "./fs-browser-server"
import { createLogArchiveStore } from "./log-db"
import { createLogReplayManager } from "./log-replay"
import { copyProjectsTree, createProjectStore, defaultUserDataRoot, isProjectStoreError, type ProjectsMigrationSummary } from "./project-store"
import { createPublishCallbacks } from "./publish"
import type { AudioFileKind, AudioServerEvent, AudioVoiceMuteItem, AudioVoiceMuteResponse, GnauralScheduleData, ProjectListResponse, ProjectSectionResponse, ProjectSettingsResponse, ProjectUndoResponse } from "./protocol"
import { isRecord, toJson } from "./protocol"
import { handleUiClose, handleUiMessage, handleUiOpen, type UiSocketData } from "./ui-ws-handler"
import { createScheduleWatcher } from "../../GnauralCore/server/schedule-watcher"
import { applyVoiceMuteMap } from "../../GnauralCore/server/gnaural-solo-render"
import { checkSpectrogramWorkerHealth } from "../../GnauralCore/server/spectrogram-bridge"

// Never route same-machine loopback fetches through a local HTTP proxy (owner: "bun must not use a
// proxy in dev"). Must run before anything issues a loopback fetch.
ensureLoopbackNoProxy()

type SocketData = UiSocketData

const hostDir = import.meta.dir
const workspaceRoot = resolve(import.meta.dir, "..", "..", "..")
const runtimeDir = hostDir
const publicDir = join(hostDir, "public")
const uiDir = resolve(hostDir, "..", "ui")
const audioConversionCacheDir = join(hostDir, "tmp", "audio-conversion")
const audioRenderCacheDir = join(hostDir, "tmp", "audio-render")
// GT6.1 (owner req. 13, GT-D11): provenance manifest for the audio output cache (render + convert).
const audioCacheManifest = new AudioCacheManifest(
  join(hostDir, "tmp", "audio-cache-manifest.json"),
  [audioRenderCacheDir, audioConversionCacheDir],
)
const { gnauralCwd, gnauralExePath } = resolveGnauralExecutablePath()
const processManager: AppSession = createSession("bodymonitor", workspaceRoot)
const archiveStore = createLogArchiveStore(runtimeDir)
const gnauralEditorStore = createGnauralEditorStore(runtimeDir)

// audio-panel-cleanup AC3.1/AC-D2: audio file access is gated on the fs-browser roots (the local
// provider's roots = the whole machine) instead of the removed presetsRoot. The byte/analysis-serving
// endpoints are additionally restricted to loopback (AC3.2/Q2=b), so this does NOT widen LAN exposure.
const localFsProvider = createLocalFsProvider()
const getAudioAccessRoots = async (): Promise<readonly string[]> =>
  (await localFsProvider.listRoots()).map((aRoot) => aRoot.path)
// project-store PR1.4 (PR-D5/D6): per-file "Project" folders under the user-data root; the root is
// re-resolved on every operation so a settings change needs no restart.
const resolveEffectiveUserDataRoot = (): string => {
  const configured = archiveStore.getProjectSettings().userDataRoot
  return configured !== "" ? configured : defaultUserDataRoot()
}
const projectStore = createProjectStore({ resolveUserDataRoot: resolveEffectiveUserDataRoot })
let gnauralSession: GnauralSession

const MAX_RESTART_ATTEMPTS = 5
const BASE_RESTART_DELAY_MS = 1000
const RETENTION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const ADMIN_COMMAND_OUTPUT_LIMIT = 4000
const BUN_RESTART_DELAY_SEC = 2
const SERVER_IDLE_TIMEOUT_SEC = 120
const isUiOnlyMode = Bun.argv.includes("--ui-only") || Bun.env.MW_UI_ONLY === "1" || Bun.env.MW_UI_ONLY?.toLowerCase() === "true"

let restartAttempt = 0
let restartTimer: ReturnType<typeof setTimeout> | null = null
let audioSessionDisposePromise: Promise<void> | null = null

const jsonResponse = (aData: unknown, aStatus = 200): Response => {
  return new Response(JSON.stringify(aData), {
    status: aStatus,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  })
}

const errorResponse = (aStatus: number, aMessage: string): Response => {
  return jsonResponse({ error: aMessage }, aStatus)
}

const parseBooleanQuery = (aValue: string | null): boolean | undefined => {
  if (aValue === null || aValue === "") {
    return undefined
  }

  if (aValue === "1" || aValue.toLowerCase() === "true") {
    return true
  }

  if (aValue === "0" || aValue.toLowerCase() === "false") {
    return false
  }

  throw new Error("favorite must be true/false or 1/0")
}

const parseOptionalNumber = (aValue: string | null): number | undefined => {
  if (aValue === null || aValue === "") {
    return undefined
  }

  const parsed = Number(aValue)
  if (!Number.isFinite(parsed)) {
    throw new Error("Invalid numeric query value")
  }

  return parsed
}

const parseSessionId = (aValue: string | undefined): number | null => {
  if (aValue === undefined) {
    return null
  }

  const parsed = Number(aValue)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null
  }

  return parsed
}

const parseJsonBody = async (aRequest: Request): Promise<unknown> => {
  try {
    return await aRequest.json()
  } catch (error) {
    throw new Error("Invalid JSON body", {
      cause: error instanceof Error ? error : undefined,
    })
  }
}

const ensureDirectory = async (aPath: string): Promise<boolean> => {
  try {
    return (await stat(aPath)).isDirectory()
  } catch {
    return false
  }
}

const ensureFile = async (aPath: string): Promise<boolean> => {
  try {
    return (await stat(aPath)).isFile()
  } catch {
    return false
  }
}

const getAudioFileMimeType = (aFileKind: AudioFileKind): string => {
  switch (aFileKind) {
    case "wav":
      return "audio/wav"
    case "flac":
      return "audio/flac"
    case "gnaural":
      return "application/xml; charset=utf-8"
  }
}

type LocalAudioFileKind = Exclude<AudioFileKind, "gnaural">

const isLocalAudioFileKind = (aFileKind: AudioFileKind): aFileKind is LocalAudioFileKind => {
  return aFileKind === "wav" || aFileKind === "flac"
}

const parseRequestedAudioFormat = (aValue: string | null): LocalAudioFileKind | null => {
  if (aValue === null || aValue === "") {
    return null
  }

  const normalizedValue = aValue.toLowerCase()
  if (normalizedValue === "wav" || normalizedValue === "flac") {
    return normalizedValue
  }

  throw new Error("format must be wav or flac")
}

const getOutputAudioFileName = (
  aSourceFilePath: string,
  aFileKind: LocalAudioFileKind,
): string => {
  return `${basename(aSourceFilePath, extname(aSourceFilePath))}.${aFileKind}`
}


// project-store PR2.4 (owner req 9): voice mute is project data. Renders must honour the
// project's voiceState section — the file's own <voice_mute> tags are stale after migration.
const projectVoiceMuteMap = async (aSourceFilePath: string): Promise<Map<number, boolean>> => {
  const muteMap = new Map<number, boolean>()

  try {
    const info = await projectStore.openProject(aSourceFilePath)
    const section = await projectStore.getSection(info.id, "voiceState")
    if (section !== null && typeof section === "object" && !Array.isArray(section)) {
      for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
        const voiceId = Number(key)
        if (!Number.isInteger(voiceId)) {
          continue
        }

        if (value !== null && typeof value === "object" && typeof (value as { muted?: unknown }).muted === "boolean") {
          muteMap.set(voiceId, (value as { muted: boolean }).muted)
        }
      }
    }
  } catch {
    // no project / unreadable section -> no overrides
  }

  return muteMap
}

// Part of the render cache key: a different project mute set is a different render.
const voiceMuteFingerprint = (aMuteMap: ReadonlyMap<number, boolean>): string => {
  if (aMuteMap.size === 0) {
    return ""
  }

  const parts = [...aMuteMap.entries()]
    .sort((aLeft, aRight) => aLeft[0] - aRight[0])
    .map(([voiceId, muted]) => `${voiceId}=${muted ? 1 : 0}`)
  return `muted:${parts.join(",")}`
}

// Render a .gnaural to WAV for spectrogram display, forcing a SINGLE loop. Gnaural has no loop
// override flag, so we render a temp copy with <loops>1</loops>. This keeps files like
// "1 s x 4900 loops" (AndromedaHell) from producing an ~868 MB WAV the browser cannot decode.
const GNAURAL_LOOPS_TAG = /<loops>\s*\d+\s*<\/loops>/i
const renderGnauralSpectrogramWav = async (aSourceFilePath: string): Promise<string> => {
  const muteMap = await projectVoiceMuteMap(aSourceFilePath)
  const muteFingerprint = voiceMuteFingerprint(muteMap)
  const discriminator = muteFingerprint === "" ? "single-loop" : `single-loop|${muteFingerprint}`
  // wave-spectrum-cache WC1.1 (WC-D2): key the render on the .gnaural CONTENT (read once, reused for
  // the single-loop transform below) so a touch / no-op re-save reuses the cached WAV. The project
  // voice-mute set is external to the file and stays in the discriminator.
  const original = await Bun.file(aSourceFilePath).text()
  const sourceFingerprint = gnauralContentFingerprint(original)
  const cachePath = await getAudioOutputCachePath(aSourceFilePath, "wav", audioRenderCacheDir, discriminator, sourceFingerprint)
  if (await ensureFile(cachePath)) {
    return cachePath
  }

  await mkdir(audioRenderCacheDir, { recursive: true })
  const singleLoopContent = applyVoiceMuteMap(original.replace(GNAURAL_LOOPS_TAG, "<loops>1</loops>"), muteMap)
  // GT10.11 (owner req. 59): the temp schedule copy MUST live next to the source file — Gnaural
  // resolves preparse generators AND pcm audio files relative to the schedule's own directory, so
  // a copy in tmp/audio-render broke both ("Preparse generator not found", silent pcm voices).
  const tempGnauralPath = join(dirname(aSourceFilePath), `.sl-${process.pid}-${randomUUID()}.gnaural`)
  const tempWavPath = join(audioRenderCacheDir, `.sl-${process.pid}-${randomUUID()}.wav`)
  await Bun.write(tempGnauralPath, singleLoopContent)

  let exitCode: number
  let stderrText: string
  try {
    const child = Bun.spawn([gnauralExePath, tempGnauralPath, "-o", tempWavPath], {
      cwd: gnauralCwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    })
    ;[stderrText, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  } finally {
    await unlink(tempGnauralPath).catch(() => undefined)
  }

  if (exitCode !== 0 || !(await ensureFile(tempWavPath))) {
    await unlink(tempWavPath).catch(() => undefined)
    throw new Error(stderrText.trim() || `Gnaural single-loop render failed with exit code ${exitCode}`)
  }

  try {
    await rename(tempWavPath, cachePath)
  } catch (error) {
    if (!(await ensureFile(cachePath))) {
      const message = error instanceof Error ? error.message : "Failed to finalize the single-loop render"
      throw new Error(message)
    }
    await unlink(tempWavPath).catch(() => undefined)
  }
  await audioCacheManifest.record(cachePath, aSourceFilePath, "wav", discriminator) // GT6.1
  return cachePath
}

const createCachedAudioOutput = async (
  aSourceFilePath: string,
  aTargetFileKind: LocalAudioFileKind,
  aCacheDir: string,
  aCommandArgs: readonly string[],
  aSpawnFailureMessage: string,
  aReadFailureMessage: string,
  aMissingOutputMessage: string,
  aOptions?: {
    readonly discriminator?: string
    // project-store PR2.4: transformed .gnaural content to render INSTEAD of the source file. It
    // is staged next to the source (Gnaural resolves preparse/pcm relative to the schedule dir,
    // GT10.11) and substituted for the source path in the command args.
    readonly stagedGnauralContent?: string | null
  },
): Promise<string> => {
  await mkdir(aCacheDir, { recursive: true })

  const targetFilePath = await getAudioOutputCachePath(aSourceFilePath, aTargetFileKind, aCacheDir, aOptions?.discriminator ?? "")
  if (await ensureFile(targetFilePath)) {
    return targetFilePath
  }

  const targetExt = extname(targetFilePath)
  const tempFilePath = join(
    dirname(targetFilePath),
    `${basename(targetFilePath, targetExt)}.${process.pid}.${randomUUID()}.tmp${targetExt}`,
  )

  const stagedContent = aOptions?.stagedGnauralContent ?? null
  const stagedInputPath = stagedContent === null
    ? null
    : join(dirname(aSourceFilePath), `.pm-${process.pid}-${randomUUID()}.gnaural`)
  if (stagedInputPath !== null && stagedContent !== null) {
    await Bun.write(stagedInputPath, stagedContent)
  }
  const effectiveArgs = stagedInputPath === null
    ? aCommandArgs
    : aCommandArgs.map((aArg) => (aArg === aSourceFilePath ? stagedInputPath : aArg))

  let child: Subprocess<"ignore", "pipe", "pipe">
  try {
    child = Bun.spawn([
      gnauralExePath,
      ...effectiveArgs,
      tempFilePath,
    ], {
      cwd: gnauralCwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    if (stagedInputPath !== null) {
      await unlink(stagedInputPath).catch(() => undefined)
    }
    const message = error instanceof Error ? error.message : aSpawnFailureMessage
    throw new Error(message)
  }

  let stdoutText: string
  let stderrText: string
  let exitCode: number

  try {
    [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
  } catch (error) {
    await unlink(tempFilePath).catch(() => undefined)
    const message = error instanceof Error ? error.message : aReadFailureMessage
    throw new Error(message)
  } finally {
    if (stagedInputPath !== null) {
      await unlink(stagedInputPath).catch(() => undefined)
    }
  }

  if (exitCode !== 0) {
    await unlink(tempFilePath).catch(() => undefined)
    throw new Error(stderrText.trim() || stdoutText.trim() || `Audio conversion failed with exit code ${exitCode}`)
  }

  if (!(await ensureFile(tempFilePath))) {
    throw new Error(aMissingOutputMessage)
  }

  try {
    await rename(tempFilePath, targetFilePath)
  } catch (error) {
    if (!(await ensureFile(targetFilePath))) {
      const message = error instanceof Error ? error.message : "Failed to finalize converted audio output"
      throw new Error(message)
    }
  } finally {
    await unlink(tempFilePath).catch(() => undefined)
  }

  // GT6.1: record provenance — 'convert' for the conversion cache, else a gnaural 'render'.
  await audioCacheManifest.record(
    targetFilePath,
    aSourceFilePath,
    aTargetFileKind,
    aCacheDir === audioConversionCacheDir ? "convert" : "render",
  )
  return targetFilePath
}

const convertAudioFile = async (
  aSourceFilePath: string,
  aTargetFileKind: LocalAudioFileKind,
): Promise<string> => {
  return createCachedAudioOutput(
    aSourceFilePath,
    aTargetFileKind,
    audioConversionCacheDir,
    ["--convert-audio", aSourceFilePath],
    "Failed to spawn Gnaural audio conversion process",
    "Failed to read Gnaural audio conversion output",
    "Converted audio output file was not created",
  )
}

const renderGnauralAudioFile = async (
  aSourceFilePath: string,
  aTargetFileKind: LocalAudioFileKind,
): Promise<string> => {
  // project-store PR2.4: honour the project's mute overrides in the full render too.
  const muteMap = await projectVoiceMuteMap(aSourceFilePath)
  const stagedGnauralContent = muteMap.size === 0
    ? null
    : applyVoiceMuteMap(await Bun.file(aSourceFilePath).text(), muteMap)

  return createCachedAudioOutput(
    aSourceFilePath,
    aTargetFileKind,
    audioRenderCacheDir,
    [aSourceFilePath, "-o"],
    "Failed to spawn Gnaural audio render process",
    "Failed to read Gnaural audio render output",
    "Rendered audio output file was not created",
    {
      discriminator: voiceMuteFingerprint(muteMap),
      stagedGnauralContent,
    },
  )
}

const createAudioFileResponse = async (
  aFilePath: string,
  aFileKind: AudioFileKind,
  aRequestedFormat: LocalAudioFileKind | null,
  aSingleLoop = false,
): Promise<Response> => {
  if (aRequestedFormat === null || aRequestedFormat === aFileKind) {
    return new Response(Bun.file(aFilePath), {
      headers: {
        "content-type": getAudioFileMimeType(aFileKind),
        "content-disposition": buildInlineContentDisposition(basename(aFilePath)),
        "cache-control": "no-store"
      }
    })
  }

  if (!isLocalAudioFileKind(aFileKind)) {
    // GT2.6 fix: the spectrogram fetch caps the render to one loop (small WAV that decodes);
    // the export/download path renders every loop as before.
    const renderedFilePath = aRequestedFormat === "wav" && aSingleLoop
      ? await renderGnauralSpectrogramWav(aFilePath)
      : await renderGnauralAudioFile(aFilePath, aRequestedFormat)
    return new Response(Bun.file(renderedFilePath), {
      headers: {
        "content-type": getAudioFileMimeType(aRequestedFormat),
        "content-disposition": buildInlineContentDisposition(getOutputAudioFileName(aFilePath, aRequestedFormat)),
        "cache-control": "no-store"
      }
    })
  }

  const transcodedFilePath = await convertAudioFile(aFilePath, aRequestedFormat)
  return new Response(Bun.file(transcodedFilePath), {
    headers: {
      "content-type": getAudioFileMimeType(aRequestedFormat),
      "content-disposition": buildInlineContentDisposition(getOutputAudioFileName(aFilePath, aRequestedFormat)),
      "cache-control": "no-store"
    }
  })
}

type JsonParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false }

const tryParseJsonText = (aText: string): JsonParseResult => {
  try {
    return {
      ok: true,
      value: JSON.parse(aText) as unknown,
    }
  } catch {
    return { ok: false }
  }
}

const parseGnauralScheduleDump = (aText: string): JsonParseResult => {
  const trimmed = aText.trim()
  if (trimmed === "") {
    return { ok: false }
  }

  const directResult = tryParseJsonText(trimmed)
  if (directResult.ok) {
    return directResult
  }

  const objectIndex = trimmed.indexOf("{")
  const arrayIndex = trimmed.indexOf("[")
  const jsonStartIndex = objectIndex === -1
    ? arrayIndex
    : arrayIndex === -1
      ? objectIndex
      : Math.min(objectIndex, arrayIndex)

  if (jsonStartIndex < 0) {
    return { ok: false }
  }

  const candidate = trimmed.slice(jsonStartIndex).trim()
  const candidateResult = tryParseJsonText(candidate)
  if (candidateResult.ok) {
    if (jsonStartIndex > 0) {
      console.warn("[server] Ignoring non-JSON schedule dump prefix emitted by Gnaural")
    }

    return candidateResult
  }

  const closingMarker = candidate.startsWith("{")
    ? "}"
    : candidate.startsWith("[")
      ? "]"
      : ""

  if (closingMarker === "") {
    return { ok: false }
  }

  const closingMarkerIndex = candidate.lastIndexOf(closingMarker)
  if (closingMarkerIndex < 0) {
    return { ok: false }
  }

  const boundedCandidate = candidate.slice(0, closingMarkerIndex + 1)
  const boundedResult = tryParseJsonText(boundedCandidate)
  if (boundedResult.ok) {
    console.warn("[server] Ignoring non-JSON schedule dump output emitted by Gnaural")
    return boundedResult
  }

  return { ok: false }
}

const dumpGnauralSchedule = async (aFilePath: string): Promise<Response> => {
  let child: Subprocess<"ignore", "pipe", "pipe">

  try {
    child = Bun.spawn([
      gnauralExePath,
      "--dump-schedule",
      aFilePath,
    ], {
      cwd: gnauralCwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to spawn Gnaural schedule dump process"
    return errorResponse(500, message)
  }

  let stdoutText: string
  let stderrText: string
  let exitCode: number

  try {
    [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Failed to read Gnaural schedule dump output"
    return errorResponse(500, message)
  }

  if (exitCode !== 0) {
    const errorMessage = stderrText.trim() || `Gnaural schedule dump failed with exit code ${exitCode}`
    return errorResponse(500, errorMessage)
  }

  if (stdoutText.trim() === "") {
    return errorResponse(500, "Gnaural schedule dump returned empty output")
  }

  const parsedDump = parseGnauralScheduleDump(stdoutText)
  if (!parsedDump.ok) {
    const stderrMessage = stderrText.trim()
    const stdoutPreview = stdoutText.trim().split(/\r?\n/u, 1)[0] ?? ""
    const diagnostic = stderrMessage || stdoutPreview

    return errorResponse(
      500,
      diagnostic === ""
        ? "Gnaural schedule dump returned invalid JSON output"
        : `Gnaural schedule dump returned invalid JSON output: ${diagnostic}`,
    )
  }

  return jsonResponse(parsedDump.value)
}

const mapGnauralEditorError = (aError: unknown): Response => {
  if (isGnauralEditorStoreError(aError)) {
    return errorResponse(aError.status, aError.message)
  }

  if (aError instanceof Error && aError.message === "Invalid JSON body") {
    return errorResponse(400, aError.message)
  }

  const message = aError instanceof Error ? aError.message : "Audio editor request failed"
  return errorResponse(500, message)
}

const mapProjectStoreError = (aError: unknown): Response => {
  if (isProjectStoreError(aError)) {
    return errorResponse(aError.status, aError.message)
  }

  if (aError instanceof Error && aError.message === "Invalid JSON body") {
    return errorResponse(400, aError.message)
  }

  const message = aError instanceof Error ? aError.message : "Project request failed"
  return errorResponse(500, message)
}

const trimCommandOutput = (aValue: string): string => {
  const normalized = aValue.trim()
  if (normalized.length <= ADMIN_COMMAND_OUTPUT_LIMIT) {
    return normalized
  }

  return normalized.slice(normalized.length - ADMIN_COMMAND_OUTPUT_LIMIT)
}

const collectCommandOutput = (aStdout: string, aStderr: string): string => {
  return trimCommandOutput([aStdout, aStderr].filter((value) => value.trim() !== "").join("\n"))
}

type AdminBunActionName = "build_ui" | "restart_exe" | "restart_bun"
type AdminBunActionState = "completed" | "scheduled"

interface AdminBunActionResponse {
  readonly action: AdminBunActionName
  readonly status: AdminBunActionState
}

interface AdminBunActionStatusResponse {
  readonly canRestartBun: boolean
  readonly restartBunReason: string | null
  readonly isWatchMode: boolean
}

interface AudioScheduleVoicePatchInput {
  readonly voiceId: number
  readonly hidden?: boolean
  readonly muted?: boolean
  readonly color?: string
}

interface AudioScheduleVoiceBatchPatchResponse {
  readonly filePath: string
  readonly modifiedAtMs: number
  readonly savedAt: string
  readonly changed: boolean
  readonly historyFileName: string | null
  readonly items: readonly {
    readonly voiceId: number
    readonly voiceIndex: number
    readonly changed: boolean
  }[]
}

const isBunWatchMode = (): boolean => {
  return process.execArgv.includes("--watch")
}

const getRestartBunBlockedReason = (): string | null => {
  return isBunWatchMode()
    ? "Restart bun is disabled while the server is running with --watch"
    : null
}

const getAdminBunActionStatus = (): AdminBunActionStatusResponse => {
  const restartBunReason = getRestartBunBlockedReason()

  return {
    canRestartBun: restartBunReason === null,
    restartBunReason,
    isWatchMode: isBunWatchMode(),
  }
}

const parseAudioScheduleVoicePatch = (value: unknown): AudioScheduleVoicePatchInput | null => {
  if (!isRecord(value) || typeof value.voiceId !== "number" || !Number.isInteger(value.voiceId)) {
    return null
  }

  if (value.hidden !== undefined && typeof value.hidden !== "boolean") {
    return null
  }

  if (value.muted !== undefined && typeof value.muted !== "boolean") {
    return null
  }

  if (value.color !== undefined && typeof value.color !== "string") {
    return null
  }

  if (value.hidden === undefined && value.muted === undefined && value.color === undefined) {
    return null
  }

  return {
    voiceId: value.voiceId,
    hidden: value.hidden,
    muted: value.muted,
    color: value.color,
  }
}

const applyLiveVoiceMuteUpdates = (
  aFilePath: string,
  aPatches: readonly AudioScheduleVoicePatchInput[],
  aItems: readonly { readonly voiceIndex: number }[],
): void => {
  const audioStatus = gnauralSession.getStatus()
  if (audioStatus.transportState === "idle" || audioStatus.filePath !== aFilePath) {
    return
  }

  for (const [index, patch] of aPatches.entries()) {
    if (patch.muted === undefined) {
      continue
    }

    const item = aItems[index]
    if (item === undefined) {
      continue
    }

    gnauralSession.setVoiceMute(item.voiceIndex, patch.muted)
  }
}

const runBunCommand = async (aArgs: readonly string[], aCwd: string): Promise<{
  readonly exitCode: number | null
  readonly output: string
}> => {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, aArgs, {
      cwd: aCwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })

    let stdout = ""
    let stderr = ""

    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
    })

    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
    })

    child.once("error", (error) => {
      rejectPromise(error)
    })

    child.once("close", (code) => {
      resolvePromise({
        exitCode: code,
        output: collectCommandOutput(stdout, stderr),
      })
    })
  })
}

const executeBuildUiAction = async (): Promise<AdminBunActionResponse> => {
  const buildResult = await runBunCommand(["run", "build"], uiDir)
  if (buildResult.exitCode !== 0) {
    throw new Error(
      buildResult.output === ""
        ? `UI build failed with exit code ${buildResult.exitCode ?? -1}`
        : buildResult.output,
    )
  }

  return {
    action: "build_ui",
    status: "completed",
  }
}

const executeRestartExeAction = async (): Promise<AdminBunActionResponse> => {
  if (replayManager.isActive()) {
    const stopped = await replayManager.stopReplay(server)
    if (!stopped) {
      throw new Error("Replay is active but could not be stopped before restarting BodyMonitor.exe")
    }
  }

  resetRestartState()
  await processManager.stop()
  await ensureBodyMonitorRunning(server)

  return {
    action: "restart_exe",
    status: "completed",
  }
}

const scheduleDetachedServerRestart = (): void => {
  const bunExecutablePath = process.execPath

  if (process.platform === "win32") {
    const child = spawn("cmd.exe", [
      "/d",
      "/s",
      "/c",
      `timeout /t ${BUN_RESTART_DELAY_SEC} /nobreak >nul && "${bunExecutablePath}" run server.ts`,
    ], {
      cwd: hostDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
    child.unref()
  } else {
    const escapedExecutablePath = bunExecutablePath.replace(/'/gu, `'\\''`)
    const child = spawn("sh", [
      "-lc",
      `sleep ${BUN_RESTART_DELAY_SEC} && exec '${escapedExecutablePath}' run server.ts`,
    ], {
      cwd: hostDir,
      detached: true,
      stdio: "ignore",
    })
    child.unref()
  }

  setTimeout(() => {
    exitAfterAudioDispose(0)
  }, 50)
}

const executeRestartBunAction = (): AdminBunActionResponse => {
  const blockedReason = getRestartBunBlockedReason()
  if (blockedReason !== null) {
    throw new Error(blockedReason)
  }

  scheduleDetachedServerRestart()

  return {
    action: "restart_bun",
    status: "scheduled",
  }
}

const runRetentionCleanup = (): void => {
  try {
    archiveStore.cleanupRetention()
  } catch (error) {
    const message = error instanceof Error ? error.message : "Retention cleanup failed"
    console.error(`[server] ${message}`)
  }
}

const resetRestartState = (): void => {
  restartAttempt = 0
  if (restartTimer !== null) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
}

const publishServerError = (aServer: Server<SocketData>, aMessage: string): void => {
  aServer.publish("ui", toJson({ type: "bodymonitor_error", message: aMessage }))
}

const createServerCallbacks = (aServer: Server<SocketData>) => {
  return createPublishCallbacks(aServer, {
    onEvent(aEvent) {
      archiveStore.captureServerEvent(aEvent)
    },
    onExit(_aRunId, aExitCode) {
      if (processManager.getState().state === "stopping") {
        resetRestartState()
        return
      }

      if (aExitCode === 0) {
        resetRestartState()
        return
      }

      if (restartTimer !== null) {
        return
      }

      if (restartAttempt >= MAX_RESTART_ATTEMPTS) {
        const terminalMessage = `BodyMonitor restart failed after ${MAX_RESTART_ATTEMPTS} attempts`
        console.error(`[server] ${terminalMessage}`)
        publishServerError(aServer, terminalMessage)
        return
      }

      const attempt = restartAttempt + 1
      const delayMs = BASE_RESTART_DELAY_MS * Math.pow(2, attempt - 1)
      restartAttempt = attempt

      const restartMessage = `BodyMonitor exited unexpectedly (code=${aExitCode}). Restart attempt ${attempt}/${MAX_RESTART_ATTEMPTS} in ${delayMs}ms`
      console.warn(`[server] ${restartMessage}`)
      publishServerError(aServer, restartMessage)

      restartTimer = setTimeout(() => {
        restartTimer = null
        void ensureBodyMonitorRunning(aServer)
      }, delayMs)
    },
    onStdioReady() {
      resetRestartState()
    },
  })
}

const ensureBodyMonitorRunning = async (aServer: Server<SocketData>): Promise<void> => {
  if (isUiOnlyMode) {
    return
  }

  if (processManager.getState().state !== "idle") {
    return
  }

  try {
    await processManager.startServer(createServerCallbacks(aServer))
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to auto-launch BodyMonitor server"
    console.error(`[server] ${message}`)

    if (restartTimer === null && restartAttempt < MAX_RESTART_ATTEMPTS) {
      const attempt = restartAttempt + 1
      const delayMs = BASE_RESTART_DELAY_MS * Math.pow(2, attempt - 1)
      restartAttempt = attempt
      publishServerError(aServer, `BodyMonitor start failed. Retry ${attempt}/${MAX_RESTART_ATTEMPTS} in ${delayMs}ms`)

      restartTimer = setTimeout(() => {
        restartTimer = null
        void ensureBodyMonitorRunning(aServer)
      }, delayMs)
    }
  }
}

let replayAudioStartToken = 0
let replayAudioTempFilePath: string | null = null

const cleanupReplayAudioTempFile = (aFilePath: string | null): void => {
  if (aFilePath === null) {
    return
  }

  void unlink(aFilePath).catch(() => undefined)
}

const replayManager = createLogReplayManager({
  archiveStore,
  processManager,
  async restoreLiveProcess(aPublisher) {
    await ensureBodyMonitorRunning(aPublisher as Server<SocketData>)
  },
  audioControl: {
    start(audioContent: string, positionSec: number): void {
      const startToken = replayAudioStartToken + 1
      replayAudioStartToken = startToken

      const tempPath = join(tmpdir(), `mindwave-gnaural-replay-${randomUUID()}.gnaural`)
      const previousTempPath = replayAudioTempFilePath
      replayAudioTempFilePath = tempPath
      cleanupReplayAudioTempFile(previousTempPath)

      void Bun.write(tempPath, audioContent).then(async () => {
        if (startToken !== replayAudioStartToken) {
          cleanupReplayAudioTempFile(tempPath)
          return
        }

        await gnauralSession.start(tempPath, [...(await getAudioAccessRoots()), dirname(tempPath)])

        if (startToken !== replayAudioStartToken) {
          if (replayAudioTempFilePath === null || replayAudioTempFilePath === tempPath) {
            gnauralSession.stop()
          }
          cleanupReplayAudioTempFile(tempPath)
          return
        }

        if (positionSec > 0) {
          gnauralSession.seek(positionSec)
        }
      }).catch(() => {
        if (replayAudioTempFilePath === tempPath) {
          replayAudioTempFilePath = null
        }
        cleanupReplayAudioTempFile(tempPath)
      })
    },
    stop(): void {
      replayAudioStartToken += 1
      gnauralSession.stop()
      const tempPath = replayAudioTempFilePath
      replayAudioTempFilePath = null
      cleanupReplayAudioTempFile(tempPath)
    },
    pause(): void {
      gnauralSession.pause()
    },
    resume(): void {
      gnauralSession.resume()
    },
  },
})

let server: Server<SocketData>

const publishAudioEvent = (aEvent: AudioServerEvent): void => {
  server.publish("ui", toJson(aEvent))
}

const scheduleWatcher = createScheduleWatcher((filePath) => {
  publishAudioEvent({ type: "audio_schedule_changed", filePath })
})

let sessionWatchedPath: string | null = null

const disposeAudioSession = async (): Promise<void> => {
  if (audioSessionDisposePromise !== null) {
    return audioSessionDisposePromise
  }

  audioSessionDisposePromise = gnauralSession.dispose().catch((error) => {
    const message = error instanceof Error ? error.message : "Failed to dispose audio session"
    console.error(`[server] ${message}`)
  })

  scheduleWatcher.dispose()
  fsBrowserServer.stop() // FB-D2: tear down the loopback file-browse server on shutdown.

  await audioSessionDisposePromise
}

const exitAfterAudioDispose = (aExitCode: number): void => {
  void disposeAudioSession().finally(() => {
    process.exit(aExitCode)
  })
}

const executeAdminBunActions = async (aRequest: Request): Promise<Response> => {
  try {
    const body = await parseJsonBody(aRequest)
    if (!isRecord(body)) {
      return errorResponse(400, "Invalid admin action payload")
    }

    const buildUi = body.buildUi === true
    const restartBun = body.restartBun === true
    const restartExe = body.restartExe === true

    if (!buildUi && !restartBun && !restartExe) {
      return errorResponse(400, "At least one admin action must be selected")
    }

    const completed: string[] = []
    const scheduled: string[] = []

    if (buildUi) {
      completed.push((await executeBuildUiAction()).action)
    }

    if (restartExe) {
      completed.push((await executeRestartExeAction()).action)
    }

    if (restartBun) {
      scheduled.push(executeRestartBunAction().action)
    }

    return jsonResponse({
      completed,
      scheduled,
    }, restartBun ? 202 : 200)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Admin action failed"
    return errorResponse(500, message)
  }
}

const registerShutdownHandlers = (): void => {
  process.once("SIGINT", () => {
    exitAfterAudioDispose(0)
  })

  process.once("SIGTERM", () => {
    exitAfterAudioDispose(0)
  })

  process.once("beforeExit", () => {
    void disposeAudioSession()
  })
}

const handleApiRequest = async (aRequest: Request): Promise<Response | null> => {
  const url = new URL(aRequest.url)
  const segments = url.pathname.split("/").filter(Boolean)

  if (segments[0] !== "api") {
    return null
  }

  if (segments.length === 2 && segments[1] === "logs") {
    if (aRequest.method !== "GET") {
      return errorResponse(405, "Method not allowed")
    }

    try {
      const favorite = parseBooleanQuery(url.searchParams.get("favorite"))
      const q = url.searchParams.get("q") ?? undefined
      const tag = url.searchParams.get("tag") ?? undefined
      const page = parseOptionalNumber(url.searchParams.get("page"))
      const pageSize = parseOptionalNumber(url.searchParams.get("pageSize"))

      return jsonResponse(archiveStore.listSessions({ favorite, q, tag, page, pageSize }))
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid logs query"
      return errorResponse(400, message)
    }
  }

  if (segments.length === 2 && segments[1] === "log-settings") {
    if (aRequest.method === "GET") {
      return jsonResponse(archiveStore.getSettings())
    }

    if (aRequest.method !== "PATCH") {
      return errorResponse(405, "Method not allowed")
    }

    try {
      const body = await parseJsonBody(aRequest)
      if (!isRecord(body) || typeof body.retentionDays !== "number") {
        return errorResponse(400, "retentionDays must be provided as a number")
      }

      return jsonResponse(archiveStore.updateSettings({ retentionDays: body.retentionDays }))
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid log settings payload"
      return errorResponse(400, message)
    }
  }

  // project-store PR2.4 (owner req 9): live in-memory mute for the running engine. Persistence
  // lives in the project's voiceState section; this endpoint only touches the active session.
  if (segments.length === 3 && segments[1] === "audio" && segments[2] === "voice-mute") {
    if (aRequest.method !== "POST") {
      return errorResponse(405, "Method not allowed")
    }

    try {
      const body = await parseJsonBody(aRequest)
      if (!isRecord(body) || typeof body.path !== "string" || !Array.isArray(body.items)) {
        return errorResponse(400, "path and items must be provided")
      }

      const items: AudioVoiceMuteItem[] = []
      for (const raw of body.items) {
        if (
          !isRecord(raw) ||
          typeof raw.voiceIndex !== "number" ||
          !Number.isInteger(raw.voiceIndex) ||
          raw.voiceIndex < 0 ||
          typeof raw.muted !== "boolean"
        ) {
          return errorResponse(400, "items must be {voiceIndex: int >= 0, muted: boolean}")
        }

        items.push({ voiceIndex: raw.voiceIndex, muted: raw.muted })
      }

      const audioStatus = gnauralSession.getStatus()
      let applied = 0
      if (audioStatus.transportState !== "idle" && audioStatus.filePath === body.path) {
        for (const item of items) {
          gnauralSession.setVoiceMute(item.voiceIndex, item.muted)
          applied += 1
        }
      }

      const payload: AudioVoiceMuteResponse = { applied }
      return jsonResponse(payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid voice-mute payload"
      return errorResponse(400, message)
    }
  }

  // project-store PR3.1 (PR-D6): the user-data root setting behind the editor settings UI.
  if (segments.length === 2 && segments[1] === "project-settings") {
    if (aRequest.method === "GET") {
      const payload: ProjectSettingsResponse = {
        ...archiveStore.getProjectSettings(),
        effectiveUserDataRoot: resolveEffectiveUserDataRoot(),
      }
      return jsonResponse(payload)
    }

    if (aRequest.method !== "PATCH") {
      return errorResponse(405, "Method not allowed")
    }

    try {
      const body = await parseJsonBody(aRequest)
      if (!isRecord(body) || typeof body.userDataRoot !== "string") {
        return errorResponse(400, "userDataRoot must be provided as a string")
      }

      const userDataRoot = body.userDataRoot.trim()
      if (userDataRoot !== "" && !(await ensureDirectory(userDataRoot))) {
        return errorResponse(400, "userDataRoot must point to an existing directory")
      }

      // PR3.2: optionally copy the projects tree from the previous root before switching. The old
      // root is never deleted (manual fallback stays available).
      let migrated: ProjectsMigrationSummary | undefined
      if (body.migrate === true) {
        const previousRoot = resolveEffectiveUserDataRoot()
        const nextRoot = userDataRoot !== "" ? userDataRoot : defaultUserDataRoot()
        migrated = await copyProjectsTree(previousRoot, nextRoot)
      }

      archiveStore.updateProjectSettings({ userDataRoot })
      const payload: ProjectSettingsResponse = {
        ...archiveStore.getProjectSettings(),
        effectiveUserDataRoot: resolveEffectiveUserDataRoot(),
        ...(migrated !== undefined ? { migrated } : {}),
      }
      return jsonResponse(payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid project settings payload"
      return errorResponse(400, message)
    }
  }

  // project-store PR1.4 (PR-D5): the "Project" entity REST surface over projectStore.
  if (segments.length === 2 && segments[1] === "projects") {
    if (aRequest.method === "GET") {
      try {
        const payload: ProjectListResponse = { projects: await projectStore.listProjects() }
        return jsonResponse(payload)
      } catch (error) {
        return mapProjectStoreError(error)
      }
    }

    if (aRequest.method === "DELETE") {
      try {
        await projectStore.deleteProject(url.searchParams.get("id") ?? "")
        return new Response(null, { status: 204 })
      } catch (error) {
        return mapProjectStoreError(error)
      }
    }

    return errorResponse(405, "Method not allowed")
  }

  if (segments.length === 3 && segments[1] === "projects" && segments[2] === "open") {
    if (aRequest.method !== "POST") {
      return errorResponse(405, "Method not allowed")
    }

    try {
      const body = await parseJsonBody(aRequest)
      if (!isRecord(body) || typeof body.path !== "string") {
        return errorResponse(400, "path must be provided as a string")
      }

      return jsonResponse(await projectStore.openProject(body.path))
    } catch (error) {
      return mapProjectStoreError(error)
    }
  }

  if (segments.length === 3 && segments[1] === "projects" && segments[2] === "info") {
    if (aRequest.method !== "GET") {
      return errorResponse(405, "Method not allowed")
    }

    try {
      const info = await projectStore.getProject(url.searchParams.get("id") ?? "")
      return info === null ? errorResponse(404, "Project not found") : jsonResponse(info)
    } catch (error) {
      return mapProjectStoreError(error)
    }
  }

  if (segments.length === 3 && segments[1] === "projects" && segments[2] === "section") {
    if (aRequest.method === "GET") {
      try {
        const id = url.searchParams.get("id") ?? ""
        const name = url.searchParams.get("name") ?? ""
        const payload: ProjectSectionResponse = { id, name, value: await projectStore.getSection(id, name) }
        return jsonResponse(payload)
      } catch (error) {
        return mapProjectStoreError(error)
      }
    }

    if (aRequest.method === "POST") {
      try {
        const body = await parseJsonBody(aRequest)
        if (!isRecord(body) || typeof body.id !== "string" || typeof body.name !== "string") {
          return errorResponse(400, "id and name must be provided as strings")
        }

        return jsonResponse(await projectStore.putSection(body.id, body.name, body.value ?? null))
      } catch (error) {
        return mapProjectStoreError(error)
      }
    }

    return errorResponse(405, "Method not allowed")
  }

  if (segments.length === 3 && segments[1] === "projects" && segments[2] === "undo") {
    if (aRequest.method === "GET") {
      try {
        const id = url.searchParams.get("id") ?? ""
        const payload: ProjectUndoResponse = { id, journal: await projectStore.getUndoJournal(id) }
        return jsonResponse(payload)
      } catch (error) {
        return mapProjectStoreError(error)
      }
    }

    if (aRequest.method === "POST") {
      try {
        const body = await parseJsonBody(aRequest)
        if (!isRecord(body) || typeof body.id !== "string") {
          return errorResponse(400, "id must be provided as a string")
        }

        await projectStore.putUndoJournal(body.id, body.journal ?? null)
        return new Response(null, { status: 204 })
      } catch (error) {
        return mapProjectStoreError(error)
      }
    }

    return errorResponse(405, "Method not allowed")
  }

  if (segments.length === 3 && segments[1] === "projects" && segments[2] === "relink") {
    if (aRequest.method !== "POST") {
      return errorResponse(405, "Method not allowed")
    }

    try {
      const body = await parseJsonBody(aRequest)
      if (!isRecord(body) || typeof body.id !== "string" || typeof body.path !== "string") {
        return errorResponse(400, "id and path must be provided as strings")
      }

      return jsonResponse(await projectStore.relinkProject(body.id, body.path))
    } catch (error) {
      return mapProjectStoreError(error)
    }
  }

  // project-store PR5.1 (PR-D10): the whole project as one portable text bundle.
  if (segments.length === 3 && segments[1] === "projects" && segments[2] === "export") {
    if (aRequest.method !== "GET") {
      return errorResponse(405, "Method not allowed")
    }

    try {
      const id = url.searchParams.get("id") ?? ""
      const bundle = await projectStore.exportProject(id)
      return new Response(`${JSON.stringify(bundle, null, 2)}\n`, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${encodeURIComponent(id)}.scpexport.json"`,
        },
      })
    } catch (error) {
      return mapProjectStoreError(error)
    }
  }

  // project-store PR5.2 (PR-D10): import a bundle; conflict -> 409 unless overwrite.
  if (segments.length === 3 && segments[1] === "projects" && segments[2] === "import") {
    if (aRequest.method !== "POST") {
      return errorResponse(405, "Method not allowed")
    }

    try {
      const body = await parseJsonBody(aRequest)
      if (!isRecord(body) || body.bundle === undefined) {
        return errorResponse(400, "bundle must be provided")
      }

      return jsonResponse(await projectStore.importProject(body.bundle, body.overwrite === true))
    } catch (error) {
      return mapProjectStoreError(error)
    }
  }

  // project-store PR4.3: reveal the project folder in the OS file manager (local desktop host).
  if (segments.length === 3 && segments[1] === "projects" && segments[2] === "reveal") {
    if (aRequest.method !== "POST") {
      return errorResponse(405, "Method not allowed")
    }

    try {
      const body = await parseJsonBody(aRequest)
      if (!isRecord(body) || typeof body.id !== "string") {
        return errorResponse(400, "id must be provided as a string")
      }

      const info = await projectStore.getProject(body.id)
      if (info === null) {
        return errorResponse(404, "Project not found")
      }

      if (process.platform !== "win32") {
        return errorResponse(501, "Reveal is only supported on Windows")
      }

      // explorer.exe exits non-zero even on success — fire and forget.
      Bun.spawn(["explorer.exe", info.dir], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      return new Response(null, { status: 204 })
    } catch (error) {
      return mapProjectStoreError(error)
    }
  }

  if (segments.length === 3 && segments[1] === "admin" && segments[2] === "bun-actions") {
    if (aRequest.method === "GET") {
      return jsonResponse(getAdminBunActionStatus())
    }

    if (aRequest.method !== "POST") {
      return errorResponse(405, "Method not allowed")
    }

    return executeAdminBunActions(aRequest)
  }

  if (segments.length === 4 && segments[1] === "admin" && segments[2] === "bun-actions") {
    if (aRequest.method !== "POST") {
      return errorResponse(405, "Method not allowed")
    }

    if (segments[3] === "build-ui") {
      try {
        return jsonResponse(await executeBuildUiAction())
      } catch (error) {
        const message = error instanceof Error ? error.message : "UI build failed"
        return errorResponse(500, message)
      }
    }

    if (segments[3] === "restart-exe") {
      try {
        return jsonResponse(await executeRestartExeAction())
      } catch (error) {
        const message = error instanceof Error ? error.message : "BodyMonitor.exe restart failed"
        const status = message.includes("Replay is active") ? 409 : 500
        return errorResponse(status, message)
      }
    }

    if (segments[3] === "restart-bun") {
      try {
        return jsonResponse(executeRestartBunAction(), 202)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Bun restart failed"
        return errorResponse(409, message)
      }
    }

    return errorResponse(404, "API route not found")
  }

  if (segments.length === 3 && segments[1] === "audio" && segments[2] === "file") {
    if (aRequest.method !== "GET") {
      return errorResponse(405, "Method not allowed")
    }

    let requestedFormat: LocalAudioFileKind | null
    try {
      requestedFormat = parseRequestedAudioFormat(url.searchParams.get("format"))
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid format query"
      return errorResponse(400, message)
    }

    const requestedPath = url.searchParams.get("path")
    if (requestedPath === null || requestedPath.trim() === "") {
      return errorResponse(400, "path query parameter is required")
    }

    const resolvedFile = resolveAllowedAudioFilePath(
      requestedPath,
      await getAudioAccessRoots(),
    )
    if (resolvedFile === null) {
      return errorResponse(403, "Requested audio file is outside the allowed roots or has an unsupported type")
    }

    if (!(await ensureFile(resolvedFile.filePath))) {
      return errorResponse(404, "Audio file not found")
    }

    const singleLoop = parseBooleanQuery(url.searchParams.get("singleLoop"))
    try {
      return await createAudioFileResponse(resolvedFile.filePath, resolvedFile.fileKind, requestedFormat, singleLoop)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load audio file"
      return errorResponse(500, message)
    }
  }

  // GT6.1 (owner req. 13, GT-D11): audio cache management. GET = summary (total + per-source +
  // orphans); DELETE = remove by entry (cacheFile), by source, or all. Deletions are guarded to the
  // cache dirs, so no arbitrary path can be removed.
  if (segments.length === 3 && segments[1] === "audio" && segments[2] === "cache") {
    if (aRequest.method === "GET") {
      return jsonResponse(await audioCacheManifest.summary())
    }
    if (aRequest.method === "DELETE") {
      const all = url.searchParams.get("all")
      const source = url.searchParams.get("source")
      const cacheFile = url.searchParams.get("cacheFile")
      if (all === "1" || all === "true") {
        return jsonResponse({ deleted: await audioCacheManifest.clearAll() })
      }
      if (source !== null && source.trim() !== "") {
        return jsonResponse({ deleted: await audioCacheManifest.deleteBySource(source) })
      }
      if (cacheFile !== null && cacheFile.trim() !== "") {
        const ok = await audioCacheManifest.deleteEntry(cacheFile)
        return ok ? jsonResponse({ deleted: 1 }) : errorResponse(400, "cacheFile is not inside the cache directory")
      }
      return errorResponse(400, "DELETE requires one of: all=1, source, or cacheFile")
    }
    return errorResponse(405, "Method not allowed")
  }

  if (segments.length === 3 && segments[1] === "audio" && segments[2] === "schedule") {
    if (aRequest.method !== "GET") {
      return errorResponse(405, "Method not allowed")
    }

    const requestedPath = url.searchParams.get("path")
    if (requestedPath === null || requestedPath.trim() === "") {
      return errorResponse(400, "path query parameter is required")
    }

    const resolvedFile = resolveAllowedAudioFilePath(
      requestedPath,
      await getAudioAccessRoots(),
    )
    if (resolvedFile === null) {
      return errorResponse(403, "Requested audio file is outside the allowed roots or has an unsupported type")
    }

    if (resolvedFile.fileKind !== "gnaural") {
      return errorResponse(400, "Only .gnaural files support schedule export")
    }

    if (!(await ensureFile(resolvedFile.filePath))) {
      return errorResponse(404, "Audio file not found")
    }

    return dumpGnauralSchedule(resolvedFile.filePath)
  }

  if (
    segments.length === 4 &&
    segments[1] === "audio" &&
    segments[2] === "schedule" &&
    segments[3] === "voice-state"
  ) {
    if (aRequest.method !== "POST") {
      return errorResponse(405, "Method not allowed")
    }

    try {
      const body = await parseJsonBody(aRequest)
      if (isRecord(body) && typeof body.path === "string" && Array.isArray(body.patches)) {
        const filePath = body.path
        const patches = body.patches
          .map(parseAudioScheduleVoicePatch)
          .filter((patch): patch is AudioScheduleVoicePatchInput => patch !== null)

        if (patches.length !== body.patches.length || patches.length === 0) {
          return errorResponse(400, "patches must be a non-empty array of valid voice-state patches")
        }

        const result = await gnauralEditorStore.patchVoiceStates(
          patches.map((patch) => ({
            path: filePath,
            voiceId: patch.voiceId,
            hidden: patch.hidden,
            muted: patch.muted,
            color: patch.color,
          })),
          await getAudioAccessRoots(),
        ) as AudioScheduleVoiceBatchPatchResponse

        applyLiveVoiceMuteUpdates(result.filePath, patches, result.items)
        return jsonResponse(result)
      }

      if (
        !isRecord(body) ||
        typeof body.path !== "string" ||
        typeof body.voiceId !== "number" ||
        !Number.isInteger(body.voiceId)
      ) {
        return errorResponse(400, "path and integer voiceId are required")
      }

      if (body.hidden !== undefined && typeof body.hidden !== "boolean") {
        return errorResponse(400, "hidden must be a boolean")
      }

      if (body.muted !== undefined && typeof body.muted !== "boolean") {
        return errorResponse(400, "muted must be a boolean")
      }

      if (body.color !== undefined && typeof body.color !== "string") {
        return errorResponse(400, "color must be a string")
      }

      if (body.hidden === undefined && body.muted === undefined && body.color === undefined) {
        return errorResponse(400, "At least one of hidden, muted, or color is required")
      }

      const result = await gnauralEditorStore.patchVoiceState({
        path: body.path,
        voiceId: body.voiceId,
        hidden: body.hidden,
        muted: body.muted,
        color: body.color,
      }, await getAudioAccessRoots())
      applyLiveVoiceMuteUpdates(result.filePath, [{ voiceId: body.voiceId, muted: body.muted }], [result])

      return jsonResponse(result)
    } catch (error) {
      return mapGnauralEditorError(error)
    }
  }

  if (segments.length === 3 && segments[1] === "audio" && segments[2] === "editor") {
    if (aRequest.method !== "GET") {
      return errorResponse(405, "Method not allowed")
    }

    const requestedPath = url.searchParams.get("path")
    if (requestedPath === null || requestedPath.trim() === "") {
      return errorResponse(400, "path query parameter is required")
    }

    try {
      return jsonResponse(await gnauralEditorStore.loadDocument(requestedPath, await getAudioAccessRoots()))
    } catch (error) {
      return mapGnauralEditorError(error)
    }
  }

  if (segments.length === 4 && segments[1] === "audio" && segments[2] === "editor" && segments[3] === "save") {
    if (aRequest.method !== "POST") {
      return errorResponse(405, "Method not allowed")
    }

    try {
      const body = await parseJsonBody(aRequest)
      if (
        !isRecord(body) ||
        typeof body.path !== "string" ||
        typeof body.content !== "string" ||
        typeof body.expectedModifiedAtMs !== "number" ||
        !Number.isFinite(body.expectedModifiedAtMs)
      ) {
        return errorResponse(400, "path, content, and expectedModifiedAtMs are required")
      }

      return jsonResponse(await gnauralEditorStore.saveDocument({
        path: body.path,
        content: body.content,
        expectedModifiedAtMs: body.expectedModifiedAtMs,
      }, await getAudioAccessRoots()))
    } catch (error) {
      return mapGnauralEditorError(error)
    }
  }

  if (segments.length === 4 && segments[1] === "audio" && segments[2] === "editor" && segments[3] === "autosave") {
    if (aRequest.method !== "POST") {
      return errorResponse(405, "Method not allowed")
    }

    try {
      const body = await parseJsonBody(aRequest)
      if (!isRecord(body) || typeof body.path !== "string" || typeof body.content !== "string") {
        return errorResponse(400, "path and content are required")
      }

      return jsonResponse(await gnauralEditorStore.autosaveDocument({
        path: body.path,
        content: body.content,
      }, await getAudioAccessRoots()))
    } catch (error) {
      return mapGnauralEditorError(error)
    }
  }

  if (segments.length === 4 && segments[1] === "audio" && segments[2] === "editor" && segments[3] === "history") {
    if (aRequest.method !== "GET") {
      return errorResponse(405, "Method not allowed")
    }

    const requestedPath = url.searchParams.get("path")
    if (requestedPath === null || requestedPath.trim() === "") {
      return errorResponse(400, "path query parameter is required")
    }

    try {
      return jsonResponse(await gnauralEditorStore.listHistory(requestedPath, await getAudioAccessRoots()))
    } catch (error) {
      return mapGnauralEditorError(error)
    }
  }

  if (
    segments.length === 5 &&
    segments[1] === "audio" &&
    segments[2] === "editor" &&
    segments[3] === "history" &&
    segments[4] === "content"
  ) {
    if (aRequest.method !== "GET") {
      return errorResponse(405, "Method not allowed")
    }

    const requestedPath = url.searchParams.get("path")
    const historyFileName = url.searchParams.get("name")
    if (requestedPath === null || requestedPath.trim() === "") {
      return errorResponse(400, "path query parameter is required")
    }

    if (historyFileName === null || historyFileName.trim() === "") {
      return errorResponse(400, "name query parameter is required")
    }

    try {
      return jsonResponse(await gnauralEditorStore.loadHistoryContent(
        requestedPath,
        historyFileName,
        await getAudioAccessRoots(),
      ))
    } catch (error) {
      return mapGnauralEditorError(error)
    }
  }

  if (
    segments.length === 5 &&
    segments[1] === "audio" &&
    segments[2] === "editor" &&
    segments[3] === "history" &&
    segments[4] === "restore"
  ) {
    if (aRequest.method !== "POST") {
      return errorResponse(405, "Method not allowed")
    }

    try {
      const body = await parseJsonBody(aRequest)
      if (
        !isRecord(body) ||
        typeof body.path !== "string" ||
        typeof body.historyFileName !== "string" ||
        typeof body.expectedModifiedAtMs !== "number" ||
        !Number.isFinite(body.expectedModifiedAtMs)
      ) {
        return errorResponse(400, "path, historyFileName, and expectedModifiedAtMs are required")
      }

      return jsonResponse(await gnauralEditorStore.restoreDocument({
        path: body.path,
        historyFileName: body.historyFileName,
        expectedModifiedAtMs: body.expectedModifiedAtMs,
      }, await getAudioAccessRoots()))
    } catch (error) {
      return mapGnauralEditorError(error)
    }
  }

  if (segments.length >= 3 && segments[1] === "logs") {
    const sessionId = parseSessionId(segments[2])
    if (sessionId === null) {
      return errorResponse(400, "Invalid log session id")
    }

    if (segments.length === 3) {
      if (aRequest.method === "GET") {
        const session = archiveStore.getSession(sessionId)
        return session === null ? errorResponse(404, "Archived log not found") : jsonResponse(session)
      }

      if (aRequest.method === "PATCH") {
        try {
          const body = await parseJsonBody(aRequest)
          if (!isRecord(body)) {
            return errorResponse(400, "Invalid log update payload")
          }

          const customName = body.customName
          const isFavorite = body.isFavorite
          const tags = body.tags
          if (
            customName !== undefined &&
            customName !== null &&
            typeof customName !== "string"
          ) {
            return errorResponse(400, "customName must be a string or null")
          }

          if (isFavorite !== undefined && typeof isFavorite !== "boolean") {
            return errorResponse(400, "isFavorite must be a boolean")
          }

          if (
            tags !== undefined &&
            tags !== null &&
            (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))
          ) {
            return errorResponse(400, "tags must be an array of strings or null")
          }

          const normalizedCustomName = customName === undefined || customName === null
            ? customName
            : customName
          const normalizedIsFavorite = isFavorite === undefined ? undefined : isFavorite
          const normalizedTags = Array.isArray(tags)
            ? [...tags]
            : tags === null
              ? null
              : undefined

          const updated = archiveStore.updateSessionMeta(sessionId, {
            customName: normalizedCustomName,
            isFavorite: normalizedIsFavorite,
            tags: normalizedTags,
          })

          return updated === null ? errorResponse(404, "Archived log not found") : jsonResponse(updated)
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid log update payload"
          return errorResponse(400, message)
        }
      }

      if (aRequest.method === "DELETE") {
        const result = archiveStore.deleteSession(sessionId)
        if (result.ok) {
          return new Response(null, { status: 204 })
        }

        if (result.reason === "active") {
          return errorResponse(409, "Active archived logs cannot be deleted")
        }

        return errorResponse(404, "Archived log not found")
      }

      return errorResponse(405, "Method not allowed")
    }

    if (segments.length === 4 && segments[3] === "events") {
      if (aRequest.method !== "GET") {
        return errorResponse(405, "Method not allowed")
      }

      try {
        const cursor = parseOptionalNumber(url.searchParams.get("cursor")) ?? 0
        const limit = parseOptionalNumber(url.searchParams.get("limit")) ?? 500
        const events = archiveStore.listSessionEvents(sessionId, cursor, limit)
        const nextCursor = events.length > 0 ? events[events.length - 1].seqNo : cursor

        return jsonResponse({
          items: events,
          nextCursor,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid events query"
        return errorResponse(400, message)
      }
    }

    if (segments.length === 4 && segments[3] === "chart") {
      if (aRequest.method !== "GET") {
        return errorResponse(405, "Method not allowed")
      }

      const chartData = archiveStore.getSessionChartData(sessionId)
      return chartData === null
        ? errorResponse(404, "Archived log not found")
        : jsonResponse(chartData)
    }
  }

  return errorResponse(404, "API route not found")
}

const getPort = (): number => {
  const cliPortArg = Bun.argv.find((arg) => arg.startsWith("--port="))
  const cliPort = cliPortArg ? Number(cliPortArg.slice("--port=".length)) : Number.NaN
  if (Number.isFinite(cliPort) && cliPort > 0) {
    return cliPort
  }

  const envPort = Number(Bun.env.PORT ?? "")
  if (Number.isFinite(envPort) && envPort > 0) {
    return envPort
  }

  return 3300
}

const mimeByExtension: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
}

const serveStatic = async (aPathname: string): Promise<Response> => {
  const normalizedPath = aPathname === "/" ? "/index.html" : aPathname
  const filePath = resolve(publicDir, `.${normalizedPath}`)
  const relativePath = relative(publicDir, filePath)

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return new Response("Forbidden", { status: 403 })
  }

  const file = Bun.file(filePath)

  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 })
  }

  const extension = extname(filePath).toLowerCase()
  const mime = mimeByExtension[extension] ?? "application/octet-stream"

  return new Response(file, {
    headers: {
      "content-type": mime,
      "cache-control": "no-store"
    }
  })
}

const rewriteGnauralXml = (xmlContent: string, schedule: GnauralScheduleData): string => {
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      isArray: (name) => name === "voice",
    })
    const doc = parser.parse(xmlContent) as Record<string, unknown>
    const root = doc["gnaural"] as Record<string, unknown> | undefined
    if (root == null) return xmlContent

    const voices = root["voice"] as unknown[] | undefined
    if (!Array.isArray(voices)) return xmlContent

    for (let i = 0; i < voices.length; i++) {
      const xmlVoice = voices[i] as Record<string, unknown>
      const schedVoice = schedule.voices[i]
      if (schedVoice == null) continue
      if (schedVoice.typeIndex === 2 && schedVoice.audioFilePath !== "") {
        xmlVoice["description"] = schedVoice.audioFilePath
      }
    }

    const builder = new XMLBuilder({ ignoreAttributes: false })
    return builder.build(doc) as string
  } catch {
    return xmlContent
  }
}

gnauralSession = createGnauralSession(runtimeDir, {
  onEvent(aEvent) {
    if (aEvent.type === "audio_schedule_loaded") {
      const logSessionId = archiveStore.noteAudioScheduleLoaded(aEvent.schedule, aEvent.loadedAtMs ?? null)
      if (logSessionId !== null) {
        void Bun.file(aEvent.filePath).text().then((xmlContent) => {
          archiveStore.noteAudioScheduleContent(logSessionId, rewriteGnauralXml(xmlContent, aEvent.schedule))
        }).catch(() => undefined)
      }

      if (sessionWatchedPath !== null) {
        scheduleWatcher.unwatch(sessionWatchedPath)
      }
      sessionWatchedPath = aEvent.filePath
      scheduleWatcher.watch(sessionWatchedPath)

      // project-store PR2.4: the engine just loaded the file's own (possibly stale) <voice_mute>
      // tags; push the project's voiceState mute overrides into the live session by voice INDEX
      // (dump order), only where they differ from what the file provided.
      const loadedSchedule = aEvent.schedule
      void projectVoiceMuteMap(aEvent.filePath).then((muteMap) => {
        if (muteMap.size === 0) {
          return
        }

        const currentStatus = gnauralSession.getStatus()
        if (currentStatus.filePath !== aEvent.filePath) {
          return
        }

        loadedSchedule.voices.forEach((aVoice, aIndex) => {
          const target = muteMap.get(aVoice.id)
          if (target !== undefined && target !== aVoice.muted) {
            gnauralSession.setVoiceMute(aIndex, target)
          }
        })
      }).catch(() => undefined)
    }

    if (aEvent.type === "audio_status" && aEvent.transportState === "idle") {
      if (sessionWatchedPath !== null) {
        scheduleWatcher.unwatch(sessionWatchedPath)
        sessionWatchedPath = null
      }
    }

    publishAudioEvent(aEvent)
  },
})

// FB1.3/FB1.4 (FB-D2): the file-browse capability runs on its OWN loopback-only (127.0.0.1) HTTP
// server, unreachable over the LAN. The main server only advertises its URL via /api/fs/info, and
// only to loopback callers.
const fsProviderRegistry = createFsProviderRegistry()
fsProviderRegistry.register(localFsProvider)
const fsBrowserServer: FsBrowserServer = startFsBrowserServer(fsProviderRegistry)

server = Bun.serve<SocketData>({
  port: getPort(),
  idleTimeout: SERVER_IDLE_TIMEOUT_SEC,
  async fetch(aRequest, aServer) {
    const url = new URL(aRequest.url)

    if (url.pathname === "/ws/ui") {
      const ok = aServer.upgrade(aRequest, {
        // AC3.2 (audio-panel-cleanup): remember the client's address so the spectrogram-open handler
        // (which reads whole-machine files via the fs-browser roots) can restrict itself to loopback.
        data: { kind: "ui", clientIp: aServer.requestIP(aRequest)?.address ?? null }
      })
      return ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 })
    }

    // FB-D2: only same-machine (loopback) callers may discover the file-browse server. Remote
    // clients get available:false and cannot reach the 127.0.0.1 bind regardless.
    if (url.pathname === "/api/fs/info") {
      const clientIp = aServer.requestIP(aRequest)?.address ?? null
      const available = isLoopbackAddress(clientIp)
      return jsonResponse({
        available,
        url: available ? fsBrowserServer.url : null,
        providers: available ? fsProviderRegistry.ids() : [],
      })
    }

    // AC3.2 (audio-panel-cleanup, Q2=b): the audio byte/schedule-serving endpoints now read from the
    // fs-browser roots (the whole machine), so — like the fs-browser itself (FB-D2) — restrict them to
    // loopback callers. A LAN client keeps the UI/WS but cannot pull arbitrary machine files as bytes.
    if (url.pathname === "/api/audio/file" || url.pathname === "/api/audio/schedule") {
      if (!isLoopbackAddress(aServer.requestIP(aRequest)?.address ?? null)) {
        return errorResponse(403, "Audio file access is restricted to same-machine (loopback) callers")
      }
    }

    const apiResponse = await handleApiRequest(aRequest)
    if (apiResponse !== null) {
      return apiResponse
    }

    return serveStatic(url.pathname)
  },
  websocket: {
    open(aSocket) {
      aSocket.subscribe("ui")
      handleUiOpen(aSocket, processManager, {
        audioSession: gnauralSession,
        archiveStore,
        getAudioAccessRoots,
        replayManager,
        replayPublisher: server,
        scheduleWatcher,
      })
    },
    async message(aSocket, aMessage) {
      const text = typeof aMessage === "string" ? aMessage : Buffer.from(aMessage).toString("utf8")
      await handleUiMessage(aSocket, processManager, text, {
        audioSession: gnauralSession,
        archiveStore,
        getAudioAccessRoots,
        replayManager,
        replayPublisher: server,
        scheduleWatcher,
      })
    },
    close(aSocket) {
      handleUiClose(aSocket, {
        audioSession: gnauralSession,
        archiveStore,
        getAudioAccessRoots,
        replayManager,
        replayPublisher: server,
        scheduleWatcher,
      })
    }
  }
})

registerShutdownHandlers()

console.log(`[server] listening on http://localhost:${server.port}`)
console.log(`[server] file-browse (loopback-only): ${fsBrowserServer.url}`)
console.log(`[server] static files: ${publicDir}`)
console.log(`[server] endpoints: /ws/ui, /api/logs, /api/log-settings, /api/audio/file, /api/audio/schedule, /api/audio/schedule/voice-state, /api/audio/voice-mute, /api/audio/editor, /api/audio/editor/save, /api/audio/editor/autosave, /api/audio/editor/history, /api/project-settings, /api/projects, /api/projects/{open,info,section,undo,relink}`)
if (isUiOnlyMode) {
  console.log("[server] UI-only mode: BodyMonitor.exe autostart disabled")
}

try {
  const finalizedCount = archiveStore.finalizeInterruptedSessions()
  if (finalizedCount > 0) {
    console.log(`[server] finalized ${finalizedCount} interrupted archived session(s)`)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Failed to finalize interrupted sessions"
  console.error(`[server] ${message}`)
}

runRetentionCleanup()
setInterval(() => {
  runRetentionCleanup()
}, RETENTION_CLEANUP_INTERVAL_MS)

void ensureBodyMonitorRunning(server)

// WP2.2: non-fatal boot health-check for the bundled spectrogram worker.
void checkSpectrogramWorkerHealth().then((health) => {
  if (health.ok) {
    console.log(`[server] spectrogram worker OK: ${health.exePath}`)
  } else {
    console.warn(`[server] spectrogram worker unavailable (${health.stage}): ${health.message}`)
  }
})

