// FB1.2 (file-browser plan, FB-D1/FB-D3): the local-filesystem provider. All Windows-vs-POSIX
// difference (drive letters vs '/', known folders, mounted volumes) is confined here — the dialog
// UI only ever consumes listRoots()/listDir()/stat(). Full-machine read is intentional; the safety
// boundary is the separate 127.0.0.1 bind (FB-D2), not a path sandbox. Paths are canonicalized on
// stat to avoid symlink surprises.

import { lstat, readdir, realpath, stat } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { basename, dirname, extname, join, resolve } from "node:path"

import type {
  FileSourceProvider,
  FsEntry,
  FsRoot,
  ListDirOptions,
  ListDirResult,
  StatResult,
} from "./fs-browser-provider"

export const LOCAL_FS_PROVIDER_ID = "local"

const isWindows = platform() === "win32"

// Lowercased extension without the leading dot; "" when there is none.
const extNoDot = (aName: string): string => {
  const ext = extname(aName)
  return ext === "" ? "" : ext.slice(1).toLowerCase()
}

// dirname() at a root is a fixed point: dirname("C:\\")==="C:\\", dirname("/")==="/". Detect that to
// return parent=null at a root boundary.
const parentOf = (aPath: string): string | null => {
  const parent = dirname(aPath)
  return parent === aPath ? null : parent
}

const statToEntry = async (aPath: string, aName: string, aIsSymlink: boolean): Promise<FsEntry | null> => {
  try {
    // stat() follows symlinks, so a link to a dir/file is classified by its target.
    const st = await stat(aPath)
    const isDir = st.isDirectory()
    const isFile = st.isFile()
    if (!isDir && !isFile) {
      return null
    }

    return {
      name: aName,
      path: aPath,
      isDir,
      isSymlink: aIsSymlink,
      size: isDir ? 0 : st.size,
      mtimeMs: st.mtimeMs,
      ext: isDir ? "" : extNoDot(aName),
      kind: isDir ? "dir" : "file",
    }
  } catch {
    // Broken symlink or an entry we cannot stat (permissions) — drop it from the listing.
    return null
  }
}

// Windows drive letters: probe A: .. Z: in parallel and keep the ones that stat.
const listWindowsDrives = async (): Promise<FsRoot[]> => {
  const letters = Array.from({ length: 26 }, (_unused, index) => String.fromCharCode(65 + index))
  const probes = await Promise.all(
    letters.map(async (letter): Promise<FsRoot | null> => {
      const path = `${letter}:\\`
      try {
        await stat(path)
        return { id: `${letter}:`, label: `${letter}:\\`, path, kind: "drive" }
      } catch {
        return null
      }
    }),
  )
  return probes.filter((root): root is FsRoot => root !== null)
}

// Best-effort mounted volumes: /Volumes (macOS), /media/<user> and /mnt (Linux). Missing dirs are
// silently skipped.
const listPosixVolumes = async (): Promise<FsRoot[]> => {
  const containers = [
    "/Volumes",
    join("/media", basename(homedir())),
    "/mnt",
  ]

  const groups = await Promise.all(
    containers.map(async (container): Promise<FsRoot[]> => {
      let names: string[]
      try {
        names = await readdir(container)
      } catch {
        return []
      }
      const mounted = await Promise.all(
        names.map(async (name): Promise<FsRoot | null> => {
          const path = join(container, name)
          try {
            if (!(await stat(path)).isDirectory()) {
              return null
            }
            return { id: path, label: name, path, kind: "volume" }
          } catch {
            return null
          }
        }),
      )
      return mounted.filter((root): root is FsRoot => root !== null)
    }),
  )

  const seen = new Set<string>()
  return groups.flat().filter((root) => {
    if (seen.has(root.id)) {
      return false
    }
    seen.add(root.id)
    return true
  })
}

// Home plus a couple of well-known subfolders, when they exist. Shared by both OS families.
const listKnownFolders = async (): Promise<FsRoot[]> => {
  const home = homedir()
  const candidates: readonly { readonly path: string; readonly label: string; readonly kind: FsRoot["kind"] }[] = [
    { path: home, label: "Home", kind: "home" },
    { path: join(home, "Desktop"), label: "Desktop", kind: "known" },
    { path: join(home, "Documents"), label: "Documents", kind: "known" },
    { path: join(home, "Downloads"), label: "Downloads", kind: "known" },
  ]

  const resolved = await Promise.all(
    candidates.map(async (candidate): Promise<FsRoot | null> => {
      try {
        if (!(await stat(candidate.path)).isDirectory()) {
          return null
        }
        return { id: candidate.path, label: candidate.label, path: candidate.path, kind: candidate.kind }
      } catch {
        return null
      }
    }),
  )
  return resolved.filter((root): root is FsRoot => root !== null)
}

export const createLocalFsProvider = (): FileSourceProvider => {
  return {
    id: LOCAL_FS_PROVIDER_ID,

    async listRoots() {
      const known = await listKnownFolders()
      if (isWindows) {
        const drives = await listWindowsDrives()
        // Known folders first (Home/Desktop/...), then drives.
        return [...known, ...drives]
      }

      const volumes = await listPosixVolumes()
      const posixRoot: FsRoot = { id: "/", label: "/", path: "/", kind: "root" }
      return [posixRoot, ...known, ...volumes]
    },

    async listDir(aPath, aOptions?: ListDirOptions) {
      const dirPath = resolve(aPath)
      const dirents = await readdir(dirPath, { withFileTypes: true })
      const showHidden = aOptions?.showHidden === true

      const entries = await Promise.all(
        dirents.map(async (dirent): Promise<FsEntry | null> => {
          if (!showHidden && dirent.name.startsWith(".")) {
            return null
          }
          const entryPath = join(dirPath, dirent.name)
          return statToEntry(entryPath, dirent.name, dirent.isSymbolicLink())
        }),
      )

      return {
        path: dirPath,
        parent: parentOf(dirPath),
        entries: entries.filter((entry): entry is FsEntry => entry !== null),
      }
    },

    async stat(aPath) {
      const requested = resolve(aPath)
      // Canonicalize (FB-D2): follow symlinks to their real target when it exists.
      let canonical = requested
      try {
        canonical = await realpath(requested)
      } catch {
        canonical = requested
      }

      try {
        const st = await stat(canonical)
        return {
          path: canonical,
          exists: true,
          isDir: st.isDirectory(),
          isFile: st.isFile(),
          size: st.isDirectory() ? 0 : st.size,
          mtimeMs: st.mtimeMs,
        }
      } catch {
        // Distinguish a dangling entry that lstat can still see from a truly absent path.
        try {
          await lstat(requested)
        } catch {
          return { path: requested, exists: false, isDir: false, isFile: false, size: 0, mtimeMs: 0 }
        }
        return { path: requested, exists: false, isDir: false, isFile: false, size: 0, mtimeMs: 0 }
      }
    },
  }
}
