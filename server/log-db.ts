import { existsSync, mkdirSync, renameSync } from "node:fs"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { buildArchivedLogChartData } from "./log-chart"
import type { ProcessStateSnapshot } from "./process-manager"
import type {
  AudioSettings,
  ArchivedLogChartData,
  ArchivedLogDetail,
  ArchivedLogEventRecord,
  ArchivedLogListResult,
  ArchivedLogSummary,
  LogDeviceSummary,
  LogSessionKind,
  LogSessionStatus,
  LogSettings,
  BodyMonitorBrowserMessage,
  BodyMonitorDeviceEvent,
  BodyMonitorDevicesEvent,
  BodyMonitorOutputEvent,
  BodyMonitorServerEvent,
  BodyMonitorStdioAckEvent,
} from "./protocol"

const DB_FILE_NAME = "mindwave-logs.sqlite"
const DB_FILE_SIDE_SUFFIXES = ["", "-shm", "-wal"] as const
const DEFAULT_RETENTION_DAYS = 30
const DEFAULT_AUDIO_PRESETS_ROOT = ""
const DEFAULT_EVENT_PAGE_SIZE = 500
const REAL_DEVICE_DATA_EVENT_NAMES = new Set([
  "hr_notification",
  "breath_phase",
  "snapshot",
  "algo_blink",
  "algo_bp",
])

interface ActiveWorkflowSession {
  readonly id: number
  readonly kind: LogSessionKind
  readonly sourceRunId?: string
  readonly createdAt: string
  readonly startedAt: string
  readonly commandLine?: string
  readonly defaultNameBase: string
  deviceSummary: LogDeviceSummary[]
  hasDeviceData: boolean
  nextSeqNo: number
}

interface SessionRow {
  readonly id: number
  readonly kind: LogSessionKind
  readonly source_run_id: string | null
  readonly created_at: string
  readonly started_at: string
  readonly ended_at: string | null
  readonly default_name: string
  readonly custom_name: string | null
  readonly is_favorite: number
  readonly status: LogSessionStatus
  readonly command_line: string | null
  readonly event_count: number
  readonly exit_code: number | null
  readonly device_summary_json: string
}

interface EventRow {
  readonly id: number
  readonly log_session_id: number
  readonly seq_no: number
  readonly created_at: string
  readonly event_type: BodyMonitorServerEvent["type"]
  readonly payload_json: string
  readonly raw_line: string | null
}

interface SessionTagRow {
  readonly log_session_id: number
  readonly tag: string
}

interface TableInfoRow {
  readonly name: string
}

interface CountRow {
  readonly total: number
}

interface PendingMonitorConfig {
  readonly params: readonly string[]
  readonly capturedAt: string
}

export interface ListLogSessionsOptions {
  readonly favorite?: boolean
  readonly q?: string
  readonly tag?: string
  readonly page?: number
  readonly pageSize?: number
}

export interface UpdateLogSessionInput {
  readonly customName?: string | null
  readonly isFavorite?: boolean
  readonly tags?: readonly string[] | null
}

export interface DeleteLogSessionResult {
  readonly ok: boolean
  readonly reason?: "not-found" | "active"
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null
}

const nowIso = (): string => {
  return new Date().toISOString()
}

const normalizeDayCount = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("retentionDays must be a non-negative finite number")
  }

  return Math.floor(value)
}

const normalizePage = (value: number | undefined, fallback: number): number => {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return fallback
  }

  return Math.floor(value)
}

const normalizePageSize = (value: number | undefined, fallback: number): number => {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return fallback
  }

  return Math.min(200, Math.floor(value))
}

const formatLocalTimestamp = (value: string): string => {
  const date = new Date(value)
  const pad = (part: number): string => String(part).padStart(2, "0")

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const createSessionBaseName = (kind: LogSessionKind, createdAt: string): string => {
  return `${kind === "scan" ? "Scan" : "Session"} ${formatLocalTimestamp(createdAt)}`
}

const uniqueDeviceSummary = (items: readonly LogDeviceSummary[]): LogDeviceSummary[] => {
  const seen = new Set<string>()
  const result: LogDeviceSummary[] = []

  for (const item of items) {
    const capability = item.capability.trim()
    const label = item.label.trim()
    if (capability === "" || label === "") {
      continue
    }

    const key = `${capability}::${label}`
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    result.push({ capability, label })
  }

  return result
}

const buildDefaultName = (baseName: string, deviceSummary: readonly LogDeviceSummary[]): string => {
  if (deviceSummary.length === 0) {
    return baseName
  }

  const summary = deviceSummary.map((item) => item.label).join(", ")
  return `${baseName} - ${summary}`
}

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const toOptionalString = (value: string | null): string | undefined => {
  return value === null ? undefined : value
}

const toOptionalNumber = (value: number | null): number | undefined => {
  return value === null ? undefined : value
}

const rowToSessionSummary = (row: SessionRow, tags: readonly string[] = []): ArchivedLogSummary => {
  const deviceSummary = uniqueDeviceSummary(parseJson<LogDeviceSummary[]>(row.device_summary_json, []))
  const customName = toOptionalString(row.custom_name)

  return {
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: toOptionalString(row.ended_at),
    defaultName: row.default_name,
    customName,
    effectiveName: customName ?? row.default_name,
    isFavorite: row.is_favorite === 1,
    status: row.status,
    sourceRunId: toOptionalString(row.source_run_id),
    commandLine: toOptionalString(row.command_line),
    eventCount: row.event_count,
    exitCode: toOptionalNumber(row.exit_code),
    deviceSummary,
    tags,
  }
}

const rowToEventRecord = (row: EventRow): ArchivedLogEventRecord => {
  const payload = parseJson<BodyMonitorServerEvent>(row.payload_json, {
    type: "bodymonitor_error",
    message: "Failed to deserialize archived event payload",
  })

  return {
    id: row.id,
    sessionId: row.log_session_id,
    seqNo: row.seq_no,
    createdAt: row.created_at,
    eventType: row.event_type,
    payload,
    rawLine: toOptionalString(row.raw_line),
  }
}

const sanitizeCustomName = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (value === null) {
    return null
  }

  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

const normalizeTagValue = (value: string): string => {
  return value.trim().toLowerCase()
}

const sanitizeTagsInput = (value: readonly string[] | null | undefined): string[] | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (value === null) {
    return []
  }

  const seen = new Set<string>()
  const result: string[] = []

  for (const item of value) {
    const normalized = normalizeTagValue(item)
    if (normalized === "" || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

const normalizeTagFilter = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined
  }

  const normalized = normalizeTagValue(value)
  return normalized === "" ? undefined : normalized
}

const getOutputRawLine = (event: BodyMonitorServerEvent): string | null => {
  if (event.type !== "bodymonitor_output") {
    return null
  }

  return event.line
}

const deriveDeviceSummaryFromMonitorParams = (params: readonly string[]): LogDeviceSummary[] => {
  const summary: LogDeviceSummary[] = []

  for (const param of params) {
    if (!param.startsWith("--") || !param.includes("=")) {
      continue
    }

    const [rawKey, rawValue] = param.slice(2).split("=", 2)
    if (rawValue === undefined || rawValue.trim() === "") {
      continue
    }

    if (rawKey === "ecg" || rawKey === "eeg" || rawKey === "blood_pressure") {
      summary.push({ capability: rawKey, label: rawValue.trim() })
    }
  }

  return uniqueDeviceSummary(summary)
}

const deriveDeviceSummaryFromDeviceEvent = (event: BodyMonitorDeviceEvent): LogDeviceSummary[] => {
  const labels = event.device.capabilities.length > 0 ? event.device.capabilities : ["device"]
  const label = event.device.comPort !== undefined
    ? `${event.device.name} [${event.device.mac}] ${event.device.comPort}`
    : `${event.device.name} [${event.device.mac}]`

  return labels.map((capability) => ({ capability, label }))
}

const deriveDeviceSummaryFromDevicesEvent = (event: BodyMonitorDevicesEvent): LogDeviceSummary[] => {
  const summary: LogDeviceSummary[] = []

  for (const device of event.devices) {
    const labels = device.capabilities.length > 0 ? device.capabilities : ["device"]
    const label = device.comPort !== undefined
      ? `${device.name} [${device.mac}] ${device.comPort}`
      : `${device.name} [${device.mac}]`

    for (const capability of labels) {
      summary.push({ capability, label })
    }
  }

  return uniqueDeviceSummary(summary)
}

const getParsedRuntimeEventName = (value: unknown): string | null => {
  if (!isRecord(value)) {
    return null
  }

  const eventName = typeof value.event === "string" ? value.event.trim() : ""
  return eventName === "" ? null : eventName
}

const isRealDeviceDataOutputEvent = (event: BodyMonitorOutputEvent): boolean => {
  if (event.stream !== "stdout") {
    return false
  }

  const eventName = getParsedRuntimeEventName(event.parsedJson)
  return eventName !== null && REAL_DEVICE_DATA_EVENT_NAMES.has(eventName)
}

const isEventRelevantForArchive = (event: BodyMonitorServerEvent): boolean => {
  switch (event.type) {
    case "bodymonitor_scan_command":
    case "bodymonitor_output":
    case "bodymonitor_device":
    case "bodymonitor_devices":
    case "bodymonitor_error":
    case "bodymonitor_exit":
    case "bodymonitor_stdio_ack":
    case "bodymonitor_status":
    case "bodymonitor_started":
    case "bodymonitor_stdio_ready":
      return true
    case "bodymonitor_server_ready":
    case "replay_started":
    case "replay_progress":
    case "replay_stopped":
    case "replay_finished":
      return false
  }
}

export class LogArchiveStore {
  private readonly db: Database
  private activeSession: ActiveWorkflowSession | null = null
  private activeWorkflowKind: LogSessionKind | null = null
  private pendingMonitorConfig: PendingMonitorConfig | null = null

  public constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true, strict: true })
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("PRAGMA foreign_keys = ON")
    this.db.run("PRAGMA synchronous = NORMAL")
    this.initializeSchema()
  }

  public close(): void {
    this.db.close(false)
  }

  public hasActiveSession(): boolean {
    return this.activeWorkflowKind !== null
  }

  public getActiveSession(): ArchivedLogSummary | null {
    if (this.activeSession === null) {
      return null
    }

    return this.getSession(this.activeSession.id)
  }

  public noteBrowserMessage(message: BodyMonitorBrowserMessage, snapshot: ProcessStateSnapshot): void {
    if (message.type === "bodymonitor_stdio_configure") {
      this.pendingMonitorConfig = {
        params: [...message.params],
        capturedAt: nowIso(),
      }
      return
    }

    if (message.type === "bodymonitor_stdio_start") {
      if (this.activeWorkflowKind !== null) {
        return
      }

      const createdAt = nowIso()
      const params = this.pendingMonitorConfig?.params ?? []
      const deviceSummary = deriveDeviceSummaryFromMonitorParams(params)
      const commandLine = params.length > 0 ? `BodyMonitor.exe ${params.join(" ")}` : snapshot.commandLine

      this.activeSession = this.createSession({
        kind: "monitor",
        createdAt,
        sourceRunId: snapshot.runId,
        commandLine,
        deviceSummary,
      })
      this.activeWorkflowKind = "monitor"
      this.pendingMonitorConfig = null
      return
    }

    if (message.type === "bodymonitor_stdio_quit") {
      this.pendingMonitorConfig = null
    }
  }

  public captureServerEvent(event: BodyMonitorServerEvent): void {
    if (event.type === "bodymonitor_scan_command") {
      if (this.activeWorkflowKind === null) {
        this.activeWorkflowKind = "scan"
      }
    }

    if (this.activeSession === null || !isEventRelevantForArchive(event)) {
      if (event.type === "bodymonitor_stdio_ack") {
        this.maybeFinalizeFromAck(event)
      }

      if (event.type === "bodymonitor_exit" && this.activeWorkflowKind === "scan") {
        this.activeWorkflowKind = null
      }

      return
    }

    this.insertEvent(this.activeSession, event)

    if (event.type === "bodymonitor_output" && isRealDeviceDataOutputEvent(event)) {
      this.markActiveSessionHasDeviceData()
    }

    if (event.type === "bodymonitor_device") {
      this.mergeDeviceSummary(deriveDeviceSummaryFromDeviceEvent(event))
    }

    if (event.type === "bodymonitor_devices") {
      this.mergeDeviceSummary(deriveDeviceSummaryFromDevicesEvent(event))
    }

    if (event.type === "bodymonitor_stdio_ack") {
      this.maybeFinalizeFromAck(event)
      return
    }

    if (event.type === "bodymonitor_exit") {
      this.finalizeActiveSession(event.exitCode === 0 ? "interrupted" : "failed", event.exitCode)
    }
  }

  public listSessions(options: ListLogSessionsOptions = {}): ArchivedLogListResult {
    const page = normalizePage(options.page, 1)
    const pageSize = normalizePageSize(options.pageSize, 25)
    const offset = (page - 1) * pageSize
    const search = options.q?.trim() ?? ""
    const favoriteFilter = options.favorite
    const tagFilter = normalizeTagFilter(options.tag)

    const whereClauses: string[] = []
    const params: Array<string | number> = ["monitor"]

    whereClauses.push("kind = ?")
    whereClauses.push("has_device_data = 1")

    if (favoriteFilter !== undefined) {
      whereClauses.push("is_favorite = ?")
      params.push(favoriteFilter ? 1 : 0)
    }

    if (search !== "") {
      whereClauses.push("(LOWER(COALESCE(custom_name, default_name)) LIKE LOWER(?) OR LOWER(device_summary_json) LIKE LOWER(?))")
      const likeValue = `%${search}%`
      params.push(likeValue, likeValue)
    }

    if (tagFilter !== undefined) {
      whereClauses.push(
        `EXISTS (
           SELECT 1
           FROM log_session_tags
           WHERE log_session_tags.log_session_id = log_sessions.id
             AND log_session_tags.tag = ?
         )`
      )
      params.push(tagFilter)
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : ""
    const totalRow = this.db
      .query<CountRow, (string | number)[]>(`SELECT COUNT(*) AS total FROM log_sessions ${whereSql}`)
      .get(...params)

    const rows = this.db
      .query<SessionRow, (string | number)[]>(
        `SELECT id, kind, source_run_id, created_at, started_at, ended_at, default_name, custom_name, is_favorite, status, command_line, event_count, exit_code, device_summary_json
         FROM log_sessions
         ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset)

    const tagsBySessionId = this.listTagsBySessionIds(rows.map((row) => row.id))

    return {
      items: rows.map((row) => rowToSessionSummary(row, tagsBySessionId.get(row.id) ?? [])),
      page,
      pageSize,
      total: totalRow?.total ?? 0,
    }
  }

  public getSession(id: number): ArchivedLogDetail | null {
    const row = this.db
      .query<SessionRow, [number]>(
        `SELECT id, kind, source_run_id, created_at, started_at, ended_at, default_name, custom_name, is_favorite, status, command_line, event_count, exit_code, device_summary_json
         FROM log_sessions
        WHERE id = ?
          AND kind = 'monitor'
          AND has_device_data = 1`
      )
      .get(id)

    if (row === null) {
      return null
    }

    const tagsBySessionId = this.listTagsBySessionIds([id])
    return rowToSessionSummary(row, tagsBySessionId.get(id) ?? [])
  }

  public listSessionEvents(sessionId: number, cursor = 0, limit = DEFAULT_EVENT_PAGE_SIZE): readonly ArchivedLogEventRecord[] {
    if (!this.hasVisibleArchivedSession(sessionId)) {
      return []
    }

    const normalizedLimit = normalizePageSize(limit, DEFAULT_EVENT_PAGE_SIZE)
    const normalizedCursor = Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) : 0

    const rows = this.db
      .query<EventRow, [number, number, number]>(
        `SELECT id, log_session_id, seq_no, created_at, event_type, payload_json, raw_line
         FROM log_events
         WHERE log_session_id = ? AND seq_no > ?
         ORDER BY seq_no ASC
         LIMIT ?`
      )
      .all(sessionId, normalizedCursor, normalizedLimit)

    return rows.map(rowToEventRecord)
  }

  public getAllSessionEvents(sessionId: number): readonly ArchivedLogEventRecord[] {
    if (!this.hasVisibleArchivedSession(sessionId)) {
      return []
    }

    const rows = this.db
      .query<EventRow, [number]>(
        `SELECT id, log_session_id, seq_no, created_at, event_type, payload_json, raw_line
         FROM log_events
         WHERE log_session_id = ?
         ORDER BY seq_no ASC`
      )
      .all(sessionId)

    return rows.map(rowToEventRecord)
  }

  public getSessionChartData(sessionId: number): ArchivedLogChartData | null {
    const session = this.getSession(sessionId)
    if (session === null) {
      return null
    }

    return buildArchivedLogChartData(session, this.getAllSessionEvents(sessionId))
  }

  public updateSessionMeta(id: number, input: UpdateLogSessionInput): ArchivedLogDetail | null {
    const existing = this.getSession(id)
    if (existing === null) {
      return null
    }

    const customName = sanitizeCustomName(input.customName)
    const isFavorite = input.isFavorite
    const tags = sanitizeTagsInput(input.tags)

    this.db.run(
      `UPDATE log_sessions
       SET custom_name = ?,
           is_favorite = COALESCE(?, is_favorite)
       WHERE id = ?`,
      [
        customName ?? existing.customName ?? null,
        isFavorite === undefined ? null : isFavorite ? 1 : 0,
        id,
      ],
    )

    if (tags !== undefined) {
      this.replaceSessionTags(id, tags)
    }

    return this.getSession(id)
  }

  public deleteSession(id: number): DeleteLogSessionResult {
    const existing = this.db
      .query<{ readonly status: LogSessionStatus } | null, [number]>(
        `SELECT status
         FROM log_sessions
         WHERE id = ?`
      )
      .get(id)

    if (existing === null) {
      return { ok: false, reason: "not-found" }
    }

    if (existing.status === "active") {
      return { ok: false, reason: "active" }
    }

    if (this.activeSession?.id === id) {
      this.activeSession = null
    }

    const result = this.db.run("DELETE FROM log_sessions WHERE id = ?", [id])
    return result.changes > 0 ? { ok: true } : { ok: false, reason: "not-found" }
  }

  public getSettings(): LogSettings {
    return {
      retentionDays: this.getRetentionDays(),
    }
  }

  public getAudioSettings(): AudioSettings {
    return {
      presetsRoot: this.getAudioPresetsRoot(),
    }
  }

  public updateSettings(input: Partial<LogSettings>): LogSettings {
    if (input.retentionDays !== undefined) {
      const nextValue = normalizeDayCount(input.retentionDays)
      this.upsertAppSetting("retention_days", nextValue)
    }

    return this.getSettings()
  }

  public updateAudioSettings(input: Partial<AudioSettings>): AudioSettings {
    if (input.presetsRoot !== undefined) {
      this.upsertAppSetting("audio_presets_root", input.presetsRoot.trim())
    }

    return this.getAudioSettings()
  }

  public cleanupRetention(referenceTime = new Date()): number {
    const retentionDays = this.getRetentionDays()
    if (retentionDays === 0) {
      return 0
    }

    const threshold = new Date(referenceTime.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
    const result = this.db.run(
      `DELETE FROM log_sessions
       WHERE is_favorite = 0
         AND status != 'active'
         AND created_at < ?`,
      [threshold],
    )

    return result.changes
  }

  public finalizeInterruptedSessions(referenceTime = nowIso()): number {
    const deletedResult = this.db.run(
      `DELETE FROM log_sessions
       WHERE kind = 'monitor'
         AND status = 'active'
         AND has_device_data = 0`
    )

    const result = this.db.run(
      `UPDATE log_sessions
       SET status = 'interrupted',
           ended_at = COALESCE(ended_at, ?)
       WHERE status = 'active'`,
      [referenceTime],
    )

    this.activeSession = null
    this.activeWorkflowKind = null
    return deletedResult.changes + result.changes
  }

  public createRuntimeSnapshot(sessionId: number): ArchivedLogDetail | null {
    return this.getSession(sessionId)
  }

  private initializeSchema(): void {
    this.db.run(
      `CREATE TABLE IF NOT EXISTS log_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK(kind IN ('scan', 'monitor')),
        source_run_id TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        default_name TEXT NOT NULL,
        custom_name TEXT,
        is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0, 1)),
        status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'failed', 'interrupted')),
        command_line TEXT,
        device_summary_json TEXT NOT NULL DEFAULT '[]',
        has_device_data INTEGER NOT NULL DEFAULT 0 CHECK(has_device_data IN (0, 1)),
        event_count INTEGER NOT NULL DEFAULT 0,
        exit_code INTEGER
      )`
    )

    this.db.run(
      `CREATE TABLE IF NOT EXISTS log_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_session_id INTEGER NOT NULL REFERENCES log_sessions(id) ON DELETE CASCADE,
        seq_no INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        raw_line TEXT,
        UNIQUE(log_session_id, seq_no)
      )`
    )

    this.db.run(
      `CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      )`
    )

    this.db.run(
      `CREATE TABLE IF NOT EXISTS log_session_tags (
        log_session_id INTEGER NOT NULL REFERENCES log_sessions(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY(log_session_id, tag)
      )`
    )

    this.ensureLogSessionSchema()
    this.backfillSessionDataAvailability()

    this.db.run("CREATE INDEX IF NOT EXISTS idx_log_sessions_created_at ON log_sessions(created_at DESC)")
    this.db.run("CREATE INDEX IF NOT EXISTS idx_log_sessions_favorite_created_at ON log_sessions(is_favorite, created_at DESC)")
    this.db.run("CREATE INDEX IF NOT EXISTS idx_log_sessions_visible_created_at ON log_sessions(kind, has_device_data, created_at DESC)")
    this.db.run("CREATE INDEX IF NOT EXISTS idx_log_events_session_seq ON log_events(log_session_id, seq_no)")
    this.db.run("CREATE INDEX IF NOT EXISTS idx_log_session_tags_tag_session ON log_session_tags(tag, log_session_id)")
    this.db.run(
      `INSERT INTO app_settings (key, value_json)
       VALUES (?, ?)
       ON CONFLICT(key) DO NOTHING`,
      ["retention_days", JSON.stringify(DEFAULT_RETENTION_DAYS)],
    )
    this.db.run(
      `INSERT INTO app_settings (key, value_json)
       VALUES (?, ?)
       ON CONFLICT(key) DO NOTHING`,
      ["audio_presets_root", JSON.stringify(DEFAULT_AUDIO_PRESETS_ROOT)],
    )
  }

  private getRetentionDays(): number {
    const parsed = this.getAppSettingValue<number>("retention_days", DEFAULT_RETENTION_DAYS)
    return normalizeDayCount(parsed)
  }

  private getAudioPresetsRoot(): string {
    const parsed = this.getAppSettingValue<string>("audio_presets_root", DEFAULT_AUDIO_PRESETS_ROOT)
    return typeof parsed === "string" ? parsed.trim() : DEFAULT_AUDIO_PRESETS_ROOT
  }

  private upsertAppSetting(key: string, value: unknown): void {
    this.db.run(
      `INSERT INTO app_settings (key, value_json)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      [key, JSON.stringify(value)],
    )
  }

  private getAppSettingValue<T>(key: string, fallback: T): T {
    const row = this.db
      .query<{ readonly value_json: string } | null, [string]>("SELECT value_json FROM app_settings WHERE key = ?")
      .get(key)

    if (row === null) {
      return fallback
    }

    return parseJson<T>(row.value_json, fallback)
  }

  private ensureLogSessionSchema(): void {
    const columns = this.db
      .query<TableInfoRow, []>("PRAGMA table_info(log_sessions)")
      .all()

    if (columns.some((column) => column.name === "has_device_data")) {
      return
    }

    this.db.run(
      `ALTER TABLE log_sessions
       ADD COLUMN has_device_data INTEGER NOT NULL DEFAULT 0`
    )
  }

  private backfillSessionDataAvailability(): void {
    const dataEventPatterns = Array.from(REAL_DEVICE_DATA_EVENT_NAMES)
      .map((eventName) => `payload_json LIKE '%"event":"${eventName}"%'`)
      .join(" OR ")

    this.db.run(
      `UPDATE log_sessions
       SET has_device_data = 1
       WHERE kind = 'monitor'
         AND EXISTS (
           SELECT 1
           FROM log_events
           WHERE log_events.log_session_id = log_sessions.id
             AND log_events.event_type = 'bodymonitor_output'
             AND (${dataEventPatterns})
         )`
    )

    this.db.run(
      `DELETE FROM log_sessions
       WHERE kind = 'monitor'
         AND status != 'active'
         AND has_device_data = 0`
    )
  }

  private hasVisibleArchivedSession(sessionId: number): boolean {
    const row = this.db
      .query<{ readonly id: number } | null, [number]>(
        `SELECT id
         FROM log_sessions
         WHERE id = ?
           AND kind = 'monitor'
           AND has_device_data = 1`
      )
      .get(sessionId)

    return row !== null
  }

  private listTagsBySessionIds(sessionIds: readonly number[]): Map<number, string[]> {
    const result = new Map<number, string[]>()
    if (sessionIds.length === 0) {
      return result
    }

    const placeholders = sessionIds.map(() => "?").join(", ")
    const rows = this.db
      .query<SessionTagRow, number[]>(
        `SELECT log_session_id, tag
         FROM log_session_tags
         WHERE log_session_id IN (${placeholders})
         ORDER BY tag ASC`
      )
      .all(...sessionIds)

    for (const row of rows) {
      const tags = result.get(row.log_session_id) ?? []
      tags.push(row.tag)
      result.set(row.log_session_id, tags)
    }

    return result
  }

  private replaceSessionTags(sessionId: number, tags: readonly string[]): void {
    this.db.run(
      `DELETE FROM log_session_tags
       WHERE log_session_id = ?`,
      [sessionId],
    )

    for (const tag of tags) {
      this.db.run(
        `INSERT INTO log_session_tags (log_session_id, tag)
         VALUES (?, ?)`,
        [sessionId, tag],
      )
    }
  }

  private createSession(input: {
    readonly kind: LogSessionKind
    readonly createdAt: string
    readonly sourceRunId?: string
    readonly commandLine?: string
    readonly deviceSummary: readonly LogDeviceSummary[]
  }): ActiveWorkflowSession {
    const createdAt = input.createdAt
    const startedAt = input.createdAt
    const baseName = createSessionBaseName(input.kind, createdAt)
    const deviceSummary = uniqueDeviceSummary(input.deviceSummary)
    const defaultName = buildDefaultName(baseName, deviceSummary)

    const insertResult = this.db.run(
      `INSERT INTO log_sessions (
         kind,
         source_run_id,
         created_at,
         started_at,
         default_name,
         status,
         command_line,
         device_summary_json
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        input.kind,
        input.sourceRunId ?? null,
        createdAt,
        startedAt,
        defaultName,
        input.commandLine ?? null,
        JSON.stringify(deviceSummary),
      ],
    )

    const sessionId = Number(insertResult.lastInsertRowid)
    return {
      id: sessionId,
      kind: input.kind,
      sourceRunId: input.sourceRunId,
      createdAt,
      startedAt,
      commandLine: input.commandLine,
      defaultNameBase: baseName,
      deviceSummary,
      hasDeviceData: false,
      nextSeqNo: 1,
    }
  }

  private insertEvent(session: ActiveWorkflowSession, event: BodyMonitorServerEvent): void {
    const createdAt = nowIso()
    this.db.run(
      `INSERT INTO log_events (
         log_session_id,
         seq_no,
         created_at,
         event_type,
         payload_json,
         raw_line
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.nextSeqNo,
        createdAt,
        event.type,
        JSON.stringify(event),
        getOutputRawLine(event),
      ],
    )
    this.db.run(
      `UPDATE log_sessions
       SET event_count = event_count + 1
       WHERE id = ?`,
      [session.id],
    )
    session.nextSeqNo += 1
  }

  private markActiveSessionHasDeviceData(): void {
    if (this.activeSession === null || this.activeSession.hasDeviceData) {
      return
    }

    this.activeSession.hasDeviceData = true
    this.db.run(
      `UPDATE log_sessions
       SET has_device_data = 1
       WHERE id = ?`,
      [this.activeSession.id],
    )
  }

  private mergeDeviceSummary(items: readonly LogDeviceSummary[]): void {
    if (this.activeSession === null) {
      return
    }

    const merged = uniqueDeviceSummary([...this.activeSession.deviceSummary, ...items])
    if (merged.length === this.activeSession.deviceSummary.length) {
      return
    }

    this.activeSession.deviceSummary = merged
    this.db.run(
      `UPDATE log_sessions
       SET device_summary_json = ?,
           default_name = ?
       WHERE id = ?`,
      [
        JSON.stringify(merged),
        buildDefaultName(this.activeSession.defaultNameBase, merged),
        this.activeSession.id,
      ],
    )
  }

  private maybeFinalizeFromAck(event: BodyMonitorStdioAckEvent): void {
    if (this.activeWorkflowKind === "scan" && event.cmd === "list_devices") {
      this.activeWorkflowKind = null
      return
    }

    const activeSession = this.activeSession
    if (activeSession === null) {
      return
    }

    if (activeSession.kind === "monitor") {
      if (event.cmd === "start" && !event.ok) {
        this.finalizeActiveSession("failed")
        return
      }

      if (event.cmd === "stop" || event.cmd === "quit") {
        this.finalizeActiveSession(event.ok ? "completed" : "failed")
      }
    }
  }

  private finalizeActiveSession(status: LogSessionStatus, exitCode?: number): void {
    const session = this.activeSession
    if (session === null) {
      return
    }

    if (session.kind === "monitor" && !session.hasDeviceData) {
      this.db.run(
        `DELETE FROM log_sessions
         WHERE id = ?`,
        [session.id],
      )

      this.activeSession = null
      this.activeWorkflowKind = null
      return
    }

    this.db.run(
      `UPDATE log_sessions
       SET status = ?,
           ended_at = ?,
           exit_code = ?
       WHERE id = ?`,
      [status, nowIso(), exitCode ?? null, session.id],
    )

    this.activeSession = null
    this.activeWorkflowKind = null
  }
}

export const createLogArchiveStore = (serverDir: string): LogArchiveStore => {
  const legacyEtcDir = join(serverDir, "etc")
  const runtimeVarDir = join(serverDir, "var")
  const dbPath = join(runtimeVarDir, DB_FILE_NAME)

  mkdirSync(runtimeVarDir, { recursive: true })

  if (!existsSync(dbPath)) {
    for (const suffix of DB_FILE_SIDE_SUFFIXES) {
      const legacyPath = join(legacyEtcDir, `${DB_FILE_NAME}${suffix}`)
      const nextPath = join(runtimeVarDir, `${DB_FILE_NAME}${suffix}`)

      if (existsSync(legacyPath) && !existsSync(nextPath)) {
        renameSync(legacyPath, nextPath)
      }
    }
  }

  return new LogArchiveStore(dbPath)
}
