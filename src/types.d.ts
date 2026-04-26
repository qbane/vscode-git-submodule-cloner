import { Uri, QuickPickItem } from 'vscode'

export interface QuickPickItemSubmod extends QuickPickItem {
  // has this submodule been checked out from gitdir?
  // is always true if in out-of-tree mode because the submodule will be self-contained
  isCheckedOut: boolean | undefined
  commitHash?: string
  url: string
  updateView(): void
}

interface RefEntry {
  name: string
  oid: string
}

export interface ServerRefInfo {
  HEAD: string | undefined
  branches: RefEntry[]
  tags: RefEntry[]
}

export interface GitCloneOptions {
  shallow?: boolean
  onProgress: (info: { message: string, increment: number }) => void | Promise<void>
}

export interface ExtensionExports {
  /**
   * Get a hash value for the given URI which is a part of its extension storage URI.
   * Should be stable across VS Code versions.
   * @see https://vscode-api.netlify.app/interfaces/vscode.extensioncontext#storageuri */
  getWorkspaceId(uri: Uri): string

  /**
   * List the branches and tags from the git server. */
  fetchServerRefInfo(url: string): Promise<ServerRefInfo>

  /**
   * Clone a git repository to the URI pointing at `dest`. */
  gitClone(url: string, dest: Uri, ref?: string, options?: GitCloneOptions): Promise<void>
}
