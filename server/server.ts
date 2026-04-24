import { mkdir, readdir, realpath, rename, stat, unlink } from "node:fs/promises"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path"
import type { Server, Subprocess } from "bun"
import { createSession, type AppSession } from "../../BodyMonitorCore/server"
import {
  buildInlineContentDisposition,
  createGnauralEditorStore,
  createGnauralSession,
  getAudioFileKind,
  getConfiguredAudioPresetsRoot,
  isGnauralEditorStoreError,
  normalizeAudioPresetsRoot,
  resolveGnauralExecutablePath,
  resolveAllowedAudioFilePath,
  type GnauralSession,
} from "../../GnauralCore/server"
import { createLogArchiveStore } from "./log-db"
import { createLogReplayManager } from "./log-replay"
import { createPublishCallbacks } from "./publish"
import type { AudioFileKind, AudioPresetsResponse, AudioServerEvent, AudioSettings, PresetTreeNode } from "./protocol"
import { isRecord, toJson } from "./protocol"
import { handleUiMessage, handleUiOpen, type UiSocketData } from "./ui-ws-handler"

type SocketData = UiSocketData

const hostDir = import.meta.dir
const workspaceRoot = resolve(import.meta.dir, "..", "..", "..")
const runtimeDir = hostDir
const publicDir = join(hostDir, "public")
const uiDir = resolve(hostDir, "..", "ui")
const audioConversionCacheDir = join(hostDir, "tmp", "audio-conversion")
const audioRenderCacheDir = join(hostDir, "tmp", "audio-render")
const { gnauralCwd, gnauralExePath } = resolveGnauralExecutablePath()
const processManager: AppSession = createSession("bodymonitor", workspaceRoot)
const archiveStore = createLogArchiveStore(runtimeDir)
const gnauralEditorStore = createGnauralEditorStore(runtimeDir)
let gnauralSession: GnauralSession

const MAX_RESTART_ATTEMPTS = 5
const BASE_RESTART_DELAY_MS = 1000
const RETENTION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const ADMIN_COMMAND_OUTPUT_LIMIT = 4000
const BUN_RESTART_DELAY_SEC = 2
const SERVER_IDLE_TIMEOUT_SEC = 120

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

const readDirUtf8 = async (aPath: string) => {
  return readdir(aPath, { withFileTypes: true, encoding: "utf8" })
}

const getDirectoryIdentity = async (aPath: string): Promise<string | null> => {
  try {
    return await realpath(aPath)
  } catch {
    return null
  }
}

const getEntryKind = async (aPath: string): Promise<"dir" | "file" | null> => {
  try {
    const entryStat = await stat(aPath)
    if (entryStat.isDirectory()) {
      return "dir"
    }

    if (entryStat.isFile()) {
      return "file"
    }

    return null
  } catch {
    return null
  }
}

const comparePresetNodes = (aLeft: PresetTreeNode, aRight: PresetTreeNode): number => {
  if (aLeft.isDir !== aRight.isDir) {
    return aLeft.isDir ? -1 : 1
  }

  return aLeft.name.localeCompare(aRight.name, undefined, { sensitivity: "base" })
}

const listPresetTree = async (
  aRootPath: string,
  aCurrentPath = aRootPath,
  aVisitedDirs = new Set<string>()
): Promise<readonly PresetTreeNode[]> => {
  const directoryIdentity = await getDirectoryIdentity(aCurrentPath)
  if (directoryIdentity !== null && aVisitedDirs.has(directoryIdentity)) {
    return []
  }

  const nextVisitedDirs = new Set(aVisitedDirs)
  if (directoryIdentity !== null) {
    nextVisitedDirs.add(directoryIdentity)
  }

  let entries: Awaited<ReturnType<typeof readDirUtf8>>
  try {
    entries = await readDirUtf8(aCurrentPath)
  } catch {
    return []
  }

  const items = await Promise.all(entries.map(async (entry): Promise<PresetTreeNode | null> => {
    const entryPath = join(aCurrentPath, entry.name)

    let entryKind: "dir" | "file" | null = null
    if (entry.isDirectory()) {
      entryKind = "dir"
    } else if (entry.isFile()) {
      entryKind = "file"
    } else {
      entryKind = await getEntryKind(entryPath)
    }

    if (entryKind === "dir") {
      const children = await listPresetTree(aRootPath, entryPath, nextVisitedDirs)
      if (children.length === 0) {
        return null
      }

      return {
        name: entry.name,
        path: entryPath,
        isDir: true,
        children,
      }
    }

    if (entryKind !== "file") {
      return null
    }

    const fileKind = getAudioFileKind(entryPath)
    if (fileKind === null) {
      return null
    }

    return {
      name: entry.name,
      path: entryPath,
      isDir: false,
      fileKind,
    }
  }))

  return items
    .filter((item): item is PresetTreeNode => item !== null)
    .sort(comparePresetNodes)
}

const createAudioPresetsResponse = async (aSettings: AudioSettings): Promise<AudioPresetsResponse | Response> => {
  const presetsRoot = getConfiguredAudioPresetsRoot(aSettings)
  if (presetsRoot === null) {
    return {
      presetsRoot: "",
      items: [],
    }
  }

  if (!(await ensureDirectory(presetsRoot))) {
    return errorResponse(400, "Configured presets root is missing or not a directory")
  }

  return {
    presetsRoot,
    items: await listPresetTree(presetsRoot),
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

const getAudioOutputCachePath = async (
  aSourceFilePath: string,
  aTargetFileKind: LocalAudioFileKind,
  aCacheDir: string,
): Promise<string> => {
  const sourceStat = await stat(aSourceFilePath)
  const sourceName = basename(aSourceFilePath, extname(aSourceFilePath))
  const cacheKey = createHash("sha1")
    .update(aSourceFilePath)
    .update("\u0000")
    .update(String(sourceStat.size))
    .update("\u0000")
    .update(String(sourceStat.mtimeMs))
    .update("\u0000")
    .update(aTargetFileKind)
    .digest("hex")

  return join(aCacheDir, `${sourceName}-${cacheKey}.${aTargetFileKind}`)
}

const createCachedAudioOutput = async (
  aSourceFilePath: string,
  aTargetFileKind: LocalAudioFileKind,
  aCacheDir: string,
  aCommandArgs: readonly string[],
  aSpawnFailureMessage: string,
  aReadFailureMessage: string,
  aMissingOutputMessage: string,
): Promise<string> => {
  await mkdir(aCacheDir, { recursive: true })

  const targetFilePath = await getAudioOutputCachePath(aSourceFilePath, aTargetFileKind, aCacheDir)
  if (await ensureFile(targetFilePath)) {
    return targetFilePath
  }

  const tempFilePath = `${targetFilePath}.${process.pid}.${randomUUID()}.tmp`

  let child: Subprocess<"ignore", "pipe", "pipe">
  try {
    child = Bun.spawn([
      gnauralExePath,
      ...aCommandArgs,
      tempFilePath,
    ], {
      cwd: gnauralCwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
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
  return createCachedAudioOutput(
    aSourceFilePath,
    aTargetFileKind,
    audioRenderCacheDir,
    [aSourceFilePath, "-o"],
    "Failed to spawn Gnaural audio render process",
    "Failed to read Gnaural audio render output",
    "Rendered audio output file was not created",
  )
}

const createAudioFileResponse = async (
  aFilePath: string,
  aFileKind: AudioFileKind,
  aRequestedFormat: LocalAudioFileKind | null,
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
    const renderedFilePath = await renderGnauralAudioFile(aFilePath, aRequestedFormat)
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
    throw new Error("Replay is active. Stop replay before restarting BodyMonitor.exe")
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

const replayManager = createLogReplayManager({
  archiveStore,
  processManager,
  async restoreLiveProcess(aPublisher) {
    await ensureBodyMonitorRunning(aPublisher as Server<SocketData>)
  }
})

let server: Server<SocketData>

const publishAudioEvent = (aEvent: AudioServerEvent): void => {
  server.publish("ui", toJson(aEvent))
}

const disposeAudioSession = async (): Promise<void> => {
  if (audioSessionDisposePromise !== null) {
    return audioSessionDisposePromise
  }

  audioSessionDisposePromise = gnauralSession.dispose().catch((error) => {
    const message = error instanceof Error ? error.message : "Failed to dispose audio session"
    console.error(`[server] ${message}`)
  })

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

  if (segments.length === 2 && segments[1] === "audio-settings") {
    if (aRequest.method === "GET") {
      return jsonResponse(archiveStore.getAudioSettings())
    }

    if (aRequest.method !== "PATCH") {
      return errorResponse(405, "Method not allowed")
    }

    try {
      const body = await parseJsonBody(aRequest)
      if (!isRecord(body) || typeof body.presetsRoot !== "string") {
        return errorResponse(400, "presetsRoot must be provided as a string")
      }

      const presetsRoot = normalizeAudioPresetsRoot(body.presetsRoot)
      if (presetsRoot !== "" && !(await ensureDirectory(presetsRoot))) {
        return errorResponse(400, "presetsRoot must point to an existing directory")
      }

      return jsonResponse(archiveStore.updateAudioSettings({ presetsRoot }))
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid audio settings payload"
      return errorResponse(400, message)
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

  if (segments.length === 3 && segments[1] === "audio" && segments[2] === "presets") {
    if (aRequest.method !== "GET") {
      return errorResponse(405, "Method not allowed")
    }

    const response = await createAudioPresetsResponse(archiveStore.getAudioSettings())
    return response instanceof Response ? response : jsonResponse(response)
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
      archiveStore.getAudioSettings(),
      gnauralSession.getServableRoots(),
    )
    if (resolvedFile === null) {
      return errorResponse(403, "Requested audio file is outside the configured presets root or has an unsupported type")
    }

    if (!(await ensureFile(resolvedFile.filePath))) {
      return errorResponse(404, "Audio file not found")
    }

    try {
      return await createAudioFileResponse(resolvedFile.filePath, resolvedFile.fileKind, requestedFormat)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load audio file"
      return errorResponse(500, message)
    }
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
      archiveStore.getAudioSettings(),
      gnauralSession.getServableRoots(),
    )
    if (resolvedFile === null) {
      return errorResponse(403, "Requested audio file is outside the configured presets root or has an unsupported type")
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
          archiveStore.getAudioSettings(),
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
      }, archiveStore.getAudioSettings())
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
      return jsonResponse(await gnauralEditorStore.loadDocument(requestedPath, archiveStore.getAudioSettings()))
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
      }, archiveStore.getAudioSettings()))
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
      }, archiveStore.getAudioSettings()))
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
      return jsonResponse(await gnauralEditorStore.listHistory(requestedPath, archiveStore.getAudioSettings()))
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
        archiveStore.getAudioSettings(),
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
      }, archiveStore.getAudioSettings()))
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

gnauralSession = createGnauralSession(runtimeDir, {
  onEvent(aEvent) {
    publishAudioEvent(aEvent)
  },
})

server = Bun.serve<SocketData>({
  port: getPort(),
  idleTimeout: SERVER_IDLE_TIMEOUT_SEC,
  async fetch(aRequest, aServer) {
    const url = new URL(aRequest.url)

    if (url.pathname === "/ws/ui") {
      const ok = aServer.upgrade(aRequest, {
        data: { kind: "ui" }
      })
      return ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 })
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
        replayManager,
        replayPublisher: server,
      })
    },
    async message(aSocket, aMessage) {
      const text = typeof aMessage === "string" ? aMessage : Buffer.from(aMessage).toString("utf8")
      await handleUiMessage(aSocket, processManager, text, {
        audioSession: gnauralSession,
        archiveStore,
        replayManager,
        replayPublisher: server,
      })
    }
  }
})

registerShutdownHandlers()

console.log(`[server] listening on http://localhost:${server.port}`)
console.log(`[server] static files: ${publicDir}`)
console.log(`[server] endpoints: /ws/ui, /api/logs, /api/log-settings, /api/audio-settings, /api/audio/presets, /api/audio/file, /api/audio/schedule, /api/audio/schedule/voice-state, /api/audio/editor, /api/audio/editor/save, /api/audio/editor/autosave, /api/audio/editor/history`)

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

