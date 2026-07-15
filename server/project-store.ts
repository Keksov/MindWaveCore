// project-store (PR1.1, plan docs/project-store): identity + folder layout for the "Project" entity.
//
// A project is a per-source-file folder under <userDataRoot>/projects/ holding everything the
// editor knows about that file (project.scp.json sections, undo.json; caches stay central, PR-D9).
// Identity (PR-D2): the normalized absolute source path, case-folded like the editor-store write
// locks, hashed to 8 hex chars and prefixed with a sanitized basename slug: <slug>-<hash8>. The
// folder name is deterministic — opening the same file always lands in the same project folder;
// renames/moves of the source are handled via source.path + relink (PR1.3/PR4.1).

import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm } from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"

export const PROJECTS_DIR_NAME = "projects"
export const PROJECT_FILE_NAME = "project.scp.json"
export const UNDO_FILE_NAME = "undo.json"
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

// --- project.scp.json storage (PR1.2, PR-D4/D7) ---------------------------------------------

export interface ProjectSourceFingerprint {
  readonly path: string
  readonly sizeBytes: number | null
  readonly modifiedAtMs: number | null
}

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

/** Tolerant read (PR-D4): missing file -> null; unreadable/foreign content is moved aside to
 *  project.scp.json.broken-<ts> (never silently destroyed) and null is returned so the caller
 *  restarts with a fresh file. */
export const readProjectFile = async (aProjectDir: string): Promise<ProjectFileData | null> => {
  const filePath = join(aProjectDir, PROJECT_FILE_NAME)
  let text: string

  try {
    text = await readFile(filePath, "utf8")
  } catch {
    return null
  }

  try {
    const parsed = JSON.parse(text) as unknown
    if (isProjectFileData(parsed)) {
      return { ...parsed, sections: { ...parsed.sections } }
    }
  } catch {
    // fall through to the broken-file recovery below
  }

  const brokenPath = `${filePath}.broken-${formatFileTimestamp(new Date())}`
  await rename(filePath, brokenPath).catch(() => undefined)
  console.error(`[project-store] Corrupt ${PROJECT_FILE_NAME} moved aside: ${brokenPath}`)
  return null
}

/** Atomic write (PR-D4): pretty JSON into a dot-temp file in the same dir, then rename over. */
export const writeProjectFile = async (aProjectDir: string, aData: ProjectFileData): Promise<void> => {
  await mkdir(aProjectDir, { recursive: true })
  const filePath = join(aProjectDir, PROJECT_FILE_NAME)
  const tempFilePath = join(aProjectDir, `.${PROJECT_FILE_NAME}.tmp-${randomUUID()}`)

  try {
    await Bun.write(tempFilePath, `${JSON.stringify(aData, null, 2)}\n`)
    await rename(tempFilePath, filePath)
  } finally {
    await rm(tempFilePath, { force: true }).catch(() => {
      // Ignore temp cleanup failures.
    })
  }
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
