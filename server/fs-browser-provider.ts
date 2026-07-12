// FB1.1 (file-browser plan, FB-D1): the source-provider abstraction for the universal file-open
// dialog. A FileSourceProvider exposes a filesystem-shaped source (local disk now; remote Bun
// agents / DB / web later) behind one interface, so the dialog UI is source-agnostic. The server
// keeps a registry keyed by provider id; the loopback-only browse server (FB-D2) dispatches through
// it. All OS-specific detail (drive letters vs '/', FB-D3) lives inside a provider, never in the UI.

export type FsEntryKind = "dir" | "file"

// One directory entry. `size` is 0 for directories; `ext` is the lowercased extension without the
// dot ("" when none). `path` is absolute and provider-navigable.
export interface FsEntry {
  readonly name: string
  readonly path: string
  readonly isDir: boolean
  readonly isSymlink: boolean
  readonly size: number
  readonly mtimeMs: number
  readonly ext: string
  readonly kind: FsEntryKind
}

// A top-level navigation anchor from listRoots(): a Windows drive, POSIX '/', the home dir, a known
// folder, or a mounted volume. The UI renders whatever the provider returns — it never enumerates
// drives itself.
export type FsRootKind = "drive" | "root" | "home" | "known" | "volume"

export interface FsRoot {
  readonly id: string
  readonly label: string
  readonly path: string
  readonly kind: FsRootKind
}

export interface ListDirResult {
  readonly path: string
  // Parent directory to navigate up to, or null at a root boundary (a drive root / '/').
  readonly parent: string | null
  readonly entries: readonly FsEntry[]
}

export interface StatResult {
  readonly path: string
  readonly exists: boolean
  readonly isDir: boolean
  readonly isFile: boolean
  readonly size: number
  readonly mtimeMs: number
}

export interface ListDirOptions {
  // Include dotfiles / hidden entries. Default false.
  readonly showHidden?: boolean
  // Reserved for a future server-side sort+paginate path for very large dirs (FB-D6); unused now.
}

export interface FileSourceProvider {
  readonly id: string
  listRoots(): Promise<readonly FsRoot[]>
  listDir(aPath: string, aOptions?: ListDirOptions): Promise<ListDirResult>
  stat(aPath: string): Promise<StatResult>
}

export interface FsProviderRegistry {
  register(aProvider: FileSourceProvider): void
  get(aId: string): FileSourceProvider | undefined
  ids(): readonly string[]
}

export const createFsProviderRegistry = (): FsProviderRegistry => {
  const providers = new Map<string, FileSourceProvider>()

  return {
    register(aProvider) {
      providers.set(aProvider.id, aProvider)
    },
    get(aId) {
      return providers.get(aId)
    },
    ids() {
      return [...providers.keys()]
    },
  }
}
