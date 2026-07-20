// project-store (PR1.1, plan docs/project-store): identity + folder layout for the "Project" entity.
//
// A project is a per-source-file folder under <userDataRoot>/projects/ holding everything the
// editor knows about that file (project.scp.json sections, undo.json; caches stay central, PR-D9).
// Identity (PR-D2): the normalized absolute source path, case-folded like the editor-store write
// locks, hashed to 8 hex chars and prefixed with a sanitized basename slug: <slug>-<hash8>. The
// folder name is deterministic — opening the same file always lands in the same project folder;
// renames/moves of the source are handled via source.path + relink (PR1.3/PR4.1).

import { createHash, randomUUID } from "node:crypto"
import type { Dirent } from "node:fs"
import { copyFile, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, extname, join, resolve, sep } from "node:path"
import type { ProjectInfo, ProjectSourceInfo } from "./protocol"
// Type-only (no runtime cycle: version-log-store imports SerialQueues from this module).
import type { VersionLogCommit, VersionLogRefs, VersionLogStore } from "./version-log-store"

export type { ProjectInfo, ProjectSourceInfo } from "./protocol"

export const PROJECTS_DIR_NAME = "projects"
export const PROJECT_FILE_NAME = "project.scp.json"
export const UNDO_FILE_NAME = "undo.json"
/** undo-versioned-log VL3.1: the per-project append-only commit log folder (version-log-store). */
export const UNDO_LOG_DIR_NAME = "undo-log"
export const PROJECT_KIND = "SoundCoreProject"

const SLUG_MAX_LENGTH = 40
const SLUG_FORBIDDEN_CHARS = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"])

// Windows-forbidden name chars, control chars, and whitespace are replaced; checked by char code
// on purpose — an escape-range regex here would embed literal control bytes into this file and
// make ripgrep treat it as binary (the server.ts NUL-byte trap).
const isReplacedSlugChar = (aChar: string): boolean => {
  return aChar.charCodeAt(0) < 0x20 || SLUG_FORBIDDEN_CHARS.has(aChar) || aChar.trim() === ""
}

export class ProjectStoreError extends Error {
  public readonly status: number

  public constructor(aStatus: number, aMessage: string) {
    super(aMessage)
    this.name = "ProjectStoreError"
    this.status = aStatus
  }
}

export const isProjectStoreError = (aValue: unknown): aValue is ProjectStoreError => {
  return aValue instanceof ProjectStoreError
}

/** Normalized absolute source path (original case preserved — it is stored for display/relink). */
export const normalizeSourcePath = (aSourcePath: string): string => {
  const trimmed = aSourcePath.trim()
  if (trimmed === "") {
    throw new ProjectStoreError(400, "path is required")
  }

  return resolve(trimmed)
}

/** Case-folded identity key — the same normalization the editor store uses for its write locks. */
export const projectIdentityKey = (aSourcePath: string): string => {
  return normalizeSourcePath(aSourcePath).toLowerCase()
}

const projectHash8 = (aSourcePath: string): string => {
  return createHash("sha1").update(projectIdentityKey(aSourcePath)).digest("hex").slice(0, 8)
}

/** Human-readable folder-name prefix: the source basename without its extension, Windows-safe.
 *  Lowercased like the identity key — the folder name must not depend on the casing a path
 *  happened to arrive with (the pretty original stays in source.path). */
export const projectSlug = (aSourcePath: string): string => {
  const base = basename(normalizeSourcePath(aSourcePath))
  const extension = extname(base)
  const stem = extension === "" ? base : base.slice(0, base.length - extension.length)
  const sanitized = [...stem.toLowerCase()]
    .map((aChar) => (isReplacedSlugChar(aChar) ? "_" : aChar))
    .join("")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/[._]+$/g, "")

  return sanitized === "" ? "project" : sanitized
}

/** Deterministic project folder name: <slug>-<hash8 of the case-folded absolute source path>. */
export const projectDirName = (aSourcePath: string): string => {
  return `${projectSlug(aSourcePath)}-${projectHash8(aSourcePath)}`
}

/** Absolute path of the project folder for a source file under the given user-data root. */
export const resolveProjectDir = (aUserDataRoot: string, aSourcePath: string): string => {
  return join(resolve(aUserDataRoot), PROJECTS_DIR_NAME, projectDirName(aSourcePath))
}

/** Default user-data root (PR-D6, owner req 8): %LOCALAPPDATA%\KKSoundCore on Windows; a dotted
 *  home fallback keeps non-Windows dev environments working. */
export const defaultUserDataRoot = (): string => {
  const localAppData = Bun.env.LOCALAPPDATA
  if (localAppData !== undefined && localAppData.trim() !== "") {
    return join(localAppData, "KKSoundCore")
  }

  return join(homedir(), ".kksoundcore")
}

// --- project.scp.json storage (PR1.2, PR-D4/D7) ---------------------------------------------

export type ProjectSourceFingerprint = ProjectSourceInfo

/** Parsed project.scp.json. Sections are opaque, subsystem-owned JSON (PR-D4); unknown sections
 *  and unknown top-level fields written by a future version are preserved on rewrite. */
export interface ProjectFileData {
  readonly [extra: string]: unknown
  readonly schemaVersion: number
  readonly kind: string
  readonly source: ProjectSourceFingerprint
  readonly createdAt: string
  readonly updatedAt: string
  readonly sections: Record<string, unknown>
}

const PROJECT_SCHEMA_VERSION = 1

const formatFileTimestamp = (aDate: Date): string => {
  const pad = (aValue: number, aWidth: number): string => String(aValue).padStart(aWidth, "0")
  const date = `${aDate.getFullYear()}-${pad(aDate.getMonth() + 1, 2)}-${pad(aDate.getDate(), 2)}`
  const time = `${pad(aDate.getHours(), 2)}-${pad(aDate.getMinutes(), 2)}-${pad(aDate.getSeconds(), 2)}-${pad(aDate.getMilliseconds(), 3)}`
  return `${date}_${time}`
}

const isRecordValue = (aValue: unknown): aValue is Record<string, unknown> => {
  return aValue !== null && typeof aValue === "object" && !Array.isArray(aValue)
}

const isProjectFileData = (aValue: unknown): aValue is ProjectFileData => {
  if (!isRecordValue(aValue)) {
    return false
  }

  return (
    aValue.schemaVersion === PROJECT_SCHEMA_VERSION &&
    aValue.kind === PROJECT_KIND &&
    isRecordValue(aValue.source) &&
    typeof aValue.source.path === "string" &&
    isRecordValue(aValue.sections)
  )
}

/** Fresh in-memory project file for a just-provisioned project. */
export const createProjectFileData = (aSource: ProjectSourceFingerprint): ProjectFileData => {
  const now = new Date().toISOString()

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    kind: PROJECT_KIND,
    source: aSource,
    createdAt: now,
    updatedAt: now,
    sections: {},
  }
}

const readJsonFileTolerant = async (
  aDir: string,
  aFileName: string,
  aIsValid: (aValue: unknown) => boolean,
  aRecoverBroken: boolean,
): Promise<unknown | null> => {
  const filePath = join(aDir, aFileName)
  let text: string

  try {
    text = await readFile(filePath, "utf8")
  } catch {
    return null
  }

  try {
    const parsed = JSON.parse(text) as unknown
    if (aIsValid(parsed)) {
      return parsed
    }
  } catch {
    // fall through to the broken-file recovery below
  }

  if (!aRecoverBroken) {
    return null
  }

  const brokenPath = `${filePath}.broken-${formatFileTimestamp(new Date())}`
  await rename(filePath, brokenPath).catch(() => undefined)
  console.error(`[project-store] Corrupt ${aFileName} moved aside: ${brokenPath}`)
  return null
}

const writeJsonFileAtomic = async (aDir: string, aFileName: string, aValue: unknown): Promise<void> => {
  await mkdir(aDir, { recursive: true })
  const filePath = join(aDir, aFileName)
  const tempFilePath = join(aDir, `.${aFileName}.tmp-${randomUUID()}`)

  try {
    await Bun.write(tempFilePath, `${JSON.stringify(aValue, null, 2)}\n`)
    await rename(tempFilePath, filePath)
  } finally {
    await rm(tempFilePath, { force: true }).catch(() => {
      // Ignore temp cleanup failures.
    })
  }
}

/** Tolerant read (PR-D4): missing file -> null; unreadable/foreign content is moved aside to
 *  project.scp.json.broken-<ts> (never silently destroyed) and null is returned so the caller
 *  restarts with a fresh file. Pass aRecoverBroken=false for read-only flows (listing) that must
 *  not touch other projects' files. */
export const readProjectFile = async (aProjectDir: string, aRecoverBroken = true): Promise<ProjectFileData | null> => {
  const parsed = await readJsonFileTolerant(aProjectDir, PROJECT_FILE_NAME, isProjectFileData, aRecoverBroken)
  if (parsed === null) {
    return null
  }

  const data = parsed as ProjectFileData
  return { ...data, sections: { ...data.sections } }
}

/** Atomic write (PR-D4): pretty JSON into a dot-temp file in the same dir, then rename over. */
export const writeProjectFile = async (aProjectDir: string, aData: ProjectFileData): Promise<void> => {
  await writeJsonFileAtomic(aProjectDir, PROJECT_FILE_NAME, aData)
}

/** Per-key sequential task queues (PR-D7) — the editor-store withFileLock pattern, keyed by
 *  project id: writes to one project never interleave, different projects proceed in parallel. */
export class SerialQueues {
  private readonly queues = new Map<string, Promise<void>>()

  public async run<T>(aKey: string, aAction: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(aKey) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(aAction)
    const queueTail = next.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(aKey, queueTail)

    try {
      return await next
    } finally {
      if (this.queues.get(aKey) === queueTail) {
        this.queues.delete(aKey)
      }
    }
  }
}

// --- ProjectStore service (PR1.3, PR-D5) ------------------------------------------------------

export interface ProjectStoreOptions {
  readonly resolveUserDataRoot: () => string | Promise<string>
  /** undo-versioned-log VL4.4: the SHARED version-log store (one instance per process — its
   *  per-dir caches and write queues must not be duplicated). Powers the export/import bundle;
   *  when absent, bundles carry undoLog: null. */
  readonly versionLog?: VersionLogStore
}

export interface ProjectStore {
  openProject(aSourcePath: string): Promise<ProjectInfo>
  getProject(aProjectId: string): Promise<ProjectInfo | null>
  listProjects(): Promise<readonly ProjectInfo[]>
  getSection(aProjectId: string, aSectionName: string): Promise<unknown>
  putSection(aProjectId: string, aSectionName: string, aValue: unknown): Promise<ProjectInfo>
  getUndoJournal(aProjectId: string): Promise<unknown>
  putUndoJournal(aProjectId: string, aJournal: unknown): Promise<void>
  deleteProject(aProjectId: string): Promise<void>
  relinkProject(aProjectId: string, aNewSourcePath: string): Promise<ProjectInfo>
  exportProject(aProjectId: string): Promise<ProjectExportBundle>
  importProject(aBundle: unknown, aOverwrite: boolean): Promise<ProjectInfo>
}

export interface ProjectUndoLogBundle {
  readonly commits: readonly VersionLogCommit[]
  readonly refs: VersionLogRefs
}

/** PR5.1 (PR-D10): a single text bundle — the whole project as one portable JSON document.
 *  undo-versioned-log VL4.4 (VL-D8): the journal side is now the whole commit log (S15). */
export interface ProjectExportBundle {
  readonly schemaVersion: number
  readonly kind: "SoundCoreProjectExport"
  readonly exportedAt: string
  readonly project: ProjectFileData
  readonly undoLog: ProjectUndoLogBundle | null
  /** Legacy v3 journal of pre-VL bundles: accepted on import (written back to undo.json so the
   *  one-time client migration picks it up), never produced by export anymore. */
  readonly undo?: unknown
}

const EXPORT_BUNDLE_KIND = "SoundCoreProjectExport"

const isProjectExportBundle = (aValue: unknown): aValue is ProjectExportBundle => {
  return (
    isRecordValue(aValue) &&
    aValue.schemaVersion === PROJECT_SCHEMA_VERSION &&
    aValue.kind === EXPORT_BUNDLE_KIND &&
    isProjectFileData(aValue.project)
  )
}

const SECTION_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/
const PROJECT_ID_HASH_SUFFIX = /-[0-9a-f]{8}$/

interface UndoFileData {
  readonly schemaVersion: number
  readonly updatedAt: string
  readonly journal: unknown
}

const isUndoFileData = (aValue: unknown): aValue is UndoFileData => {
  return isRecordValue(aValue) && aValue.schemaVersion === PROJECT_SCHEMA_VERSION && "journal" in aValue
}

const isInsideDir = (aBaseDir: string, aTarget: string): boolean => {
  const base = resolve(aBaseDir)
  const target = resolve(aTarget)
  return target === base || target.startsWith(base + sep)
}

const assertValidSectionName = (aSectionName: string): void => {
  if (!SECTION_NAME_PATTERN.test(aSectionName)) {
    throw new ProjectStoreError(400, "Invalid section name")
  }
}

/** A project id is a folder name we generated: no separators, ends with the 8-hex hash. */
export const isSafeProjectId = (aProjectId: string): boolean => {
  return (
    aProjectId.length > 0 &&
    aProjectId.length <= 128 &&
    !aProjectId.includes("/") &&
    !aProjectId.includes("\\") &&
    !aProjectId.includes("..") &&
    basename(aProjectId) === aProjectId &&
    PROJECT_ID_HASH_SUFFIX.test(aProjectId)
  )
}

const assertSafeProjectId = (aProjectId: string): void => {
  if (!isSafeProjectId(aProjectId)) {
    throw new ProjectStoreError(400, "Invalid project id")
  }
}

const fingerprintSource = async (aNormalizedPath: string): Promise<ProjectSourceFingerprint> => {
  try {
    const sourceStat = await stat(aNormalizedPath)
    if (!sourceStat.isFile()) {
      throw new ProjectStoreError(400, "Source path is not a file")
    }

    return {
      path: aNormalizedPath,
      sizeBytes: sourceStat.size,
      modifiedAtMs: Math.trunc(sourceStat.mtimeMs),
    }
  } catch (error) {
    if (isProjectStoreError(error)) {
      throw error
    }

    throw new ProjectStoreError(404, "Source file not found")
  }
}

class ProjectStoreImpl implements ProjectStore {
  private readonly queues = new SerialQueues()

  public constructor(private readonly options: ProjectStoreOptions) {}

  public async openProject(aSourcePath: string): Promise<ProjectInfo> {
    const normalizedPath = normalizeSourcePath(aSourcePath)
    const fingerprint = await fingerprintSource(normalizedPath)
    const projectsRoot = await this.projectsRoot()
    const located = await this.locateProject(projectsRoot, normalizedPath)

    return this.queues.run(located.id, async () => {
      const existing = await readProjectFile(located.dir)

      if (existing === null) {
        const created = createProjectFileData(fingerprint)
        await writeProjectFile(located.dir, created)
        return this.buildInfo(located.id, located.dir, created)
      }

      const fingerprintChanged =
        existing.source.path !== fingerprint.path ||
        existing.source.sizeBytes !== fingerprint.sizeBytes ||
        existing.source.modifiedAtMs !== fingerprint.modifiedAtMs
      // A case-only path variation must not rewrite the stored (pretty) path on every open.
      const identityEqual = projectIdentityKey(existing.source.path) === projectIdentityKey(fingerprint.path)
      const nextSourcePath = identityEqual ? existing.source.path : fingerprint.path

      if (!fingerprintChanged) {
        return this.buildInfo(located.id, located.dir, existing)
      }

      const updated: ProjectFileData = {
        ...existing,
        source: { ...fingerprint, path: nextSourcePath },
        updatedAt: new Date().toISOString(),
      }
      await writeProjectFile(located.dir, updated)
      return this.buildInfo(located.id, located.dir, updated)
    })
  }

  public async getProject(aProjectId: string): Promise<ProjectInfo | null> {
    assertSafeProjectId(aProjectId)
    const projectsRoot = await this.projectsRoot()
    const dir = join(projectsRoot, aProjectId)
    const data = await readProjectFile(dir)

    return data === null ? null : this.buildInfo(aProjectId, dir, data)
  }

  public async listProjects(): Promise<readonly ProjectInfo[]> {
    const projectsRoot = await this.projectsRoot()
    let entries: Dirent[]

    try {
      entries = await readdir(projectsRoot, { withFileTypes: true })
    } catch {
      return []
    }

    const infos: ProjectInfo[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      const dir = join(projectsRoot, entry.name)
      const data = await readProjectFile(dir, false)
      if (data === null) {
        continue
      }

      infos.push(await this.buildInfo(entry.name, dir, data))
    }

    return infos.sort((aLeft, aRight) => aRight.updatedAt.localeCompare(aLeft.updatedAt))
  }

  public async getSection(aProjectId: string, aSectionName: string): Promise<unknown> {
    assertValidSectionName(aSectionName)
    const data = await this.requireProjectData(aProjectId)
    return data.data.sections[aSectionName] ?? null
  }

  public async putSection(aProjectId: string, aSectionName: string, aValue: unknown): Promise<ProjectInfo> {
    assertSafeProjectId(aProjectId)
    assertValidSectionName(aSectionName)

    return this.queues.run(aProjectId, async () => {
      const { dir, data } = await this.requireProjectData(aProjectId)
      const sections = { ...data.sections }

      if (aValue === null || aValue === undefined) {
        delete sections[aSectionName]
      } else {
        sections[aSectionName] = aValue
      }

      const updated: ProjectFileData = { ...data, sections, updatedAt: new Date().toISOString() }
      await writeProjectFile(dir, updated)
      return this.buildInfo(aProjectId, dir, updated)
    })
  }

  public async getUndoJournal(aProjectId: string): Promise<unknown> {
    assertSafeProjectId(aProjectId)
    const projectsRoot = await this.projectsRoot()
    const dir = join(projectsRoot, aProjectId)
    const parsed = await readJsonFileTolerant(dir, UNDO_FILE_NAME, isUndoFileData, true)

    return parsed === null ? null : (parsed as UndoFileData).journal
  }

  public async putUndoJournal(aProjectId: string, aJournal: unknown): Promise<void> {
    assertSafeProjectId(aProjectId)
    // undo-versioned-log VL4.4 (VL-D8): the v3 journal is write-dead — the only surviving write
    // is the migration's `null` (delete undo.json after a confirmed replay into the log). The
    // 5 MB cap died with the writes.
    if (aJournal !== null && aJournal !== undefined) {
      throw new ProjectStoreError(410, "Legacy undo.json writes are gone; the undo history lives at /api/projects/undo-log")
    }

    await this.queues.run(aProjectId, async () => {
      const { dir } = await this.requireProjectData(aProjectId)
      await rm(join(dir, UNDO_FILE_NAME), { force: true }).catch(() => undefined)
    })
  }

  public async deleteProject(aProjectId: string): Promise<void> {
    assertSafeProjectId(aProjectId)
    const projectsRoot = await this.projectsRoot()
    const dir = join(projectsRoot, aProjectId)

    if (!isInsideDir(projectsRoot, dir)) {
      throw new ProjectStoreError(403, "Project folder is outside the projects root")
    }

    await this.queues.run(aProjectId, async () => {
      if (await readProjectFile(dir, false) === null) {
        throw new ProjectStoreError(404, "Project not found")
      }

      await rm(dir, { recursive: true, force: true })
    })
  }

  public async exportProject(aProjectId: string): Promise<ProjectExportBundle> {
    const { dir, data } = await this.requireProjectData(aProjectId)

    // VL4.4 (S15): the bundle carries the whole commit log; an empty log exports as null.
    let undoLog: ProjectUndoLogBundle | null = null
    const versionLog = this.options.versionLog
    if (versionLog !== undefined) {
      const logDir = join(dir, UNDO_LOG_DIR_NAME)
      const commits = await versionLog.listCommits(logDir)
      const refs = await versionLog.getRefs(logDir)
      const empty = commits.length === 0 && refs.main === null && refs.head === null && Object.keys(refs.tags).length === 0
      undoLog = empty ? null : { commits, refs }
    }

    return {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      kind: EXPORT_BUNDLE_KIND,
      exportedAt: new Date().toISOString(),
      project: data,
      undoLog,
    }
  }

  public async importProject(aBundle: unknown, aOverwrite: boolean): Promise<ProjectInfo> {
    if (!isProjectExportBundle(aBundle)) {
      throw new ProjectStoreError(400, "Not a SoundCoreProject export bundle")
    }

    const sourcePath = aBundle.project.source.path
    const id = projectDirName(sourcePath)
    const projectsRoot = await this.projectsRoot()
    const dir = join(projectsRoot, id)

    return this.queues.run(id, async () => {
      const existing = await readProjectFile(dir, false)
      if (existing !== null && !aOverwrite) {
        throw new ProjectStoreError(409, "A project for this source file already exists")
      }

      const imported: ProjectFileData = {
        ...aBundle.project,
        sections: { ...aBundle.project.sections },
        updatedAt: new Date().toISOString(),
      }
      await writeProjectFile(dir, imported)

      // VL4.4 (S15): restore the commit log byte-for-byte (raw import — GC graft roots and
      // orphan branches are legal in a STORED log, so append semantics do not apply here).
      const versionLog = this.options.versionLog
      if (versionLog !== undefined) {
        const logDir = join(dir, UNDO_LOG_DIR_NAME)
        const rawLog = aBundle.undoLog
        if (isRecordValue(rawLog) && Array.isArray(rawLog.commits) && isRecordValue(rawLog.refs)) {
          const refs = rawLog.refs as { main?: unknown; head?: unknown; tags?: unknown }
          await versionLog.importLog(logDir, rawLog.commits as VersionLogCommit[], {
            main: typeof refs.main === "string" ? refs.main : null,
            head: typeof refs.head === "string" ? refs.head : null,
            tags: isRecordValue(refs.tags) ? (refs.tags as Record<string, string>) : {},
          })
        } else {
          await versionLog.clear(logDir)
        }
      }

      // A pre-VL bundle carries a legacy v3 `undo` journal: write it back to undo.json so the
      // one-time client migration converts it on the next open.
      if (aBundle.undo !== null && aBundle.undo !== undefined) {
        const payload: UndoFileData = {
          schemaVersion: PROJECT_SCHEMA_VERSION,
          updatedAt: new Date().toISOString(),
          journal: aBundle.undo,
        }
        await writeJsonFileAtomic(dir, UNDO_FILE_NAME, payload)
      } else {
        await rm(join(dir, UNDO_FILE_NAME), { force: true }).catch(() => undefined)
      }

      return this.buildInfo(id, dir, imported)
    })
  }

  public async relinkProject(aProjectId: string, aNewSourcePath: string): Promise<ProjectInfo> {
    assertSafeProjectId(aProjectId)
    const normalizedPath = normalizeSourcePath(aNewSourcePath)
    const fingerprint = await fingerprintSource(normalizedPath)

    return this.queues.run(aProjectId, async () => {
      const { dir, data } = await this.requireProjectData(aProjectId)
      const updated: ProjectFileData = {
        ...data,
        source: fingerprint,
        updatedAt: new Date().toISOString(),
      }
      await writeProjectFile(dir, updated)
      return this.buildInfo(aProjectId, dir, updated)
    })
  }

  private async projectsRoot(): Promise<string> {
    const userDataRoot = await this.options.resolveUserDataRoot()
    return join(resolve(userDataRoot), PROJECTS_DIR_NAME)
  }

  /** Primary lookup by the deterministic hash dir; falls back to scanning stored source paths so a
   *  relinked project (folder named after the OLD path) is still found when its file is reopened. */
  private async locateProject(
    aProjectsRoot: string,
    aNormalizedPath: string,
  ): Promise<{ readonly id: string; readonly dir: string }> {
    const id = projectDirName(aNormalizedPath)
    const dir = join(aProjectsRoot, id)

    if (await readProjectFile(dir, false) !== null) {
      return { id, dir }
    }

    const identityKey = projectIdentityKey(aNormalizedPath)
    let entries: Dirent[]

    try {
      entries = await readdir(aProjectsRoot, { withFileTypes: true })
    } catch {
      return { id, dir }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      const candidateDir = join(aProjectsRoot, entry.name)
      const data = await readProjectFile(candidateDir, false)
      if (data !== null && projectIdentityKey(data.source.path) === identityKey) {
        return { id: entry.name, dir: candidateDir }
      }
    }

    return { id, dir }
  }

  private async requireProjectData(aProjectId: string): Promise<{ readonly dir: string; readonly data: ProjectFileData }> {
    assertSafeProjectId(aProjectId)
    const projectsRoot = await this.projectsRoot()
    const dir = join(projectsRoot, aProjectId)
    const data = await readProjectFile(dir)

    if (data === null) {
      throw new ProjectStoreError(404, "Project not found")
    }

    return { dir, data }
  }

  private async buildInfo(aProjectId: string, aDir: string, aData: ProjectFileData): Promise<ProjectInfo> {
    const sourceExists = await Bun.file(aData.source.path)
      .exists()
      .catch(() => false)

    // undo-global-journal UG4.2 (req 6) + undo-versioned-log VL3.1 (VL-D8): one number for the
    // project's undo footprint — the version log folder plus the legacy undo.json while it still
    // exists (pre-migration).
    const legacyUndoBytes = await stat(join(aDir, UNDO_FILE_NAME))
      .then((s) => (s.isFile() ? s.size : 0))
      .catch(() => 0)
    let undoLogBytes = 0
    try {
      const logDir = join(aDir, UNDO_LOG_DIR_NAME)
      for (const entry of await readdir(logDir, { withFileTypes: true })) {
        if (entry.isFile()) {
          undoLogBytes += await stat(join(logDir, entry.name))
            .then((s) => s.size)
            .catch(() => 0)
        }
      }
    } catch {
      // The project has no undo-log folder yet.
    }
    const undoTotalBytes = legacyUndoBytes + undoLogBytes
    const undoJournalBytes = undoTotalBytes === 0 ? null : undoTotalBytes

    return {
      id: aProjectId,
      dir: aDir,
      source: aData.source,
      sourceStatus: sourceExists ? "ok" : "missing",
      createdAt: aData.createdAt,
      updatedAt: aData.updatedAt,
      sections: Object.keys(aData.sections),
      undoJournalBytes,
    }
  }
}

export const createProjectStore = (aOptions: ProjectStoreOptions): ProjectStore => {
  return new ProjectStoreImpl(aOptions)
}

// --- user-data root migration (PR3.2, PR-D6) --------------------------------------------------

export interface ProjectsMigrationSummary {
  readonly copied: number
  readonly skipped: number
}

const directoryExists = async (aPath: string): Promise<boolean> => {
  try {
    return (await stat(aPath)).isDirectory()
  } catch {
    return false
  }
}

const copyDirRecursive = async (aFromDir: string, aToDir: string): Promise<void> => {
  await mkdir(aToDir, { recursive: true })
  const entries = await readdir(aFromDir, { withFileTypes: true })

  for (const entry of entries) {
    const from = join(aFromDir, entry.name)
    const to = join(aToDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirRecursive(from, to)
    } else if (entry.isFile()) {
      await copyFile(from, to)
    }
  }
}

/** Copy every project folder from <fromRoot>/projects into <toRoot>/projects. A folder that
 *  already exists at the destination is left untouched (skipped); the source is never modified —
 *  the old root stays intact as a manual fallback (plan: no auto-delete). */
export const copyProjectsTree = async (aFromRoot: string, aToRoot: string): Promise<ProjectsMigrationSummary> => {
  const fromDir = join(resolve(aFromRoot), PROJECTS_DIR_NAME)
  const toDir = join(resolve(aToRoot), PROJECTS_DIR_NAME)
  if (fromDir.toLowerCase() === toDir.toLowerCase()) {
    return { copied: 0, skipped: 0 }
  }

  let entries: Dirent[]
  try {
    entries = await readdir(fromDir, { withFileTypes: true })
  } catch {
    return { copied: 0, skipped: 0 }
  }

  let copied = 0
  let skipped = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const target = join(toDir, entry.name)
    if (await directoryExists(target)) {
      skipped += 1
      continue
    }

    await copyDirRecursive(join(fromDir, entry.name), target)
    copied += 1
  }

  return { copied, skipped }
}
