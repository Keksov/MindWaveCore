// project-store (PR1.1, plan docs/project-store): identity + folder layout for the "Project" entity.
//
// A project is a per-source-file folder under <userDataRoot>/projects/ holding everything the
// editor knows about that file (project.scp.json sections, undo.json; caches stay central, PR-D9).
// Identity (PR-D2): the normalized absolute source path, case-folded like the editor-store write
// locks, hashed to 8 hex chars and prefixed with a sanitized basename slug: <slug>-<hash8>. The
// folder name is deterministic — opening the same file always lands in the same project folder;
// renames/moves of the source are handled via source.path + relink (PR1.3/PR4.1).

import { createHash } from "node:crypto"
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
