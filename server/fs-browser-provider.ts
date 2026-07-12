// FB1.1 (file-browser plan, FB-D1): the source-provider abstraction for the universal file-open
// dialog. A FileSourceProvider exposes a filesystem-shaped source (local disk now; remote Bun
// agents / DB / web later) behind one interface, so the dialog UI is source-agnostic. The server
// keeps a registry keyed by provider id; the loopback-only browse server (FB-D2) dispatches through
// it. All OS-specific detail (drive letters vs '/', FB-D3) lives inside a provider, never in the UI.

// The data shapes (FsEntry/FsRoot/ListDirResult/StatResult) live in the shared protocol so the UI
// consumes the exact same types via @protocol (FB-D1). Re-exported here so server modules can keep
// importing them from "./fs-browser-provider".
export type {
  FsEntry,
  FsEntryKind,
  FsRoot,
  FsRootKind,
  ListDirResult,
  StatResult,
} from "./protocol"

import type { FsRoot, ListDirResult, StatResult } from "./protocol"

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
