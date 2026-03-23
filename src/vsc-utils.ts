import { window, workspace, env, UIKind, type Uri } from 'vscode'

export function isWeb() {
  return env.uiKind === UIKind.Web
}

export function folderIsGitHubRemoteRepo(uri: Uri) {
  return uri.scheme === 'vscode-vfs' && uri.authority.match(/^github\+?/)
}

export function maybeChooseWSFolderUri(): Uri | PromiseLike<Uri | null> {
  function _inner() {
    const fos = workspace.workspaceFolders
    if (!fos?.length) {
      throw new Error('No workspace folder to work on.')
    }

    function ensureUri(uri: Uri | undefined): Uri {
      if (!uri) {
        throw new Error(`Failed to get URI of the main workspace folder.`)
      }
      return uri
    }

    if (fos.length == 1) return ensureUri(fos[0]!.uri)

    // if there is a virtual workspace, use it (we save everything in one place for out-of-tree clones)
    const vws = fos.find(x => folderIsGitHubRemoteRepo(x.uri))
    if (vws) return vws.uri

    // roll my own picker to exclude aux dirs in spaghetti
    // but the experience will be subpar since we do not have access to resource label formatters
    // return Promise.all(fos.map(f => {
    //   return workspace.fs.stat(Uri.joinPath(f.uri, '.gitmodules'))
    //     .then(s => s.type === vscode.FileType.File ? f : null, () => null)
    // })).then(xs => xs.filter(x => !!x)).then(ffs => {
    //   if (ffs.length == 1) return ensureUri(ffs[0]!.uri, true)
    //   return window.showQuickPick(ffs.map(x => ({x, label: x.uri.toString(), description: x.name})))
    //     .then(item => item?.x.uri)
    // })

    return window.showWorkspaceFolderPick({
      placeHolder: 'Choose a workspace folder to work on...'
    }).then(x => x?.uri ?? null)
  }

  try { return _inner() } catch (err: any) {
    return window.showErrorMessage(err.message).then(() => null)
  }
}

// from the API reference:
// > Note: it is not valid to call updateWorkspaceFolders() multiple times without waiting for
// > the onDidChangeWorkspaceFolders() to fire.
async function updateWorkspaceFoldersSafe(
  start: number,
  deleteCount: number | null | undefined,
  ...workspaceFoldersToAdd: { readonly name?: string, readonly uri: Uri }[]) {

  let resolve: Function
  const promise = new Promise(res => resolve = res)

  // somehow vscode will emit bogus events with no added/removed folders
  const disposable = workspace.onDidChangeWorkspaceFolders(ev => {
    if (ev.added.length || ev.removed.length) {
      resolve()
    }
  })

  try {
    const ok = workspace.updateWorkspaceFolders(start, deleteCount, ...workspaceFoldersToAdd)
    if (ok) await promise
    return ok
  } finally {
    disposable.dispose()
  }
}

export async function appendWorkspaceFolders(folders: { name?: string, uri: Uri }[]) {
  let allOk = true
  const getLen = () => workspace.workspaceFolders?.length ?? 0

  for (const folder of folders) {
    const uriStr = folder.uri.toString()
    const existing = workspace.workspaceFolders?.find(f => f.uri.toString() === uriStr)?.index ?? -1
    const atLast = existing >= 0 && existing === getLen() - 1
    if (!atLast) {
      if (existing >= 0) {
        allOk &&= await updateWorkspaceFoldersSafe(existing, 1)
      }
      allOk &&= await updateWorkspaceFoldersSafe(getLen(), 0, folder)
    }
  }

  return allOk
}
