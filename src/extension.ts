import type { ExtensionContext, QuickPickItem } from 'vscode'
import vscode, { window, commands, workspace, Uri } from 'vscode'
import git, { type ProgressCallback } from 'isomorphic-git'
import http from '$isogit-http'
import path from '$node-path'
import { createIsoGitAsyncFs, exists } from './fs'
import { type GitSubmoduleSpec } from './gitmodules'
import { hexToAscii, textEncode } from './utils'
import { createIsoGitProgressReporter, findSubmoduleOid, readGitModules, type IsoGitBaseOptions } from './gitops'
import { getWorkspaceId } from './workspace-id'
import {
  folderIsGitHubRemoteRepo,
  maybeChooseWSFolderUri,
  appendWorkspaceFolders,
  isWeb,
} from './vsc-utils'

function getScopedGlobalStorageUri(context: ExtensionContext, root: Uri): Uri {
  if (!folderIsGitHubRemoteRepo(root)) {
    return context.storageUri!
  }
  const id = getWorkspaceId(root)
  return Uri.joinPath(context.globalStorageUri!, id)
}

function makeContextFromWorkspaceFolder(context: ExtensionContext, root: Uri) {
  const isOnVirtualWorkspace = root && folderIsGitHubRemoteRepo(root)

  // this is essentially equivalent as above, except that you can change it to true on desktop
  // to try out the remote repository behavior
  const isCloningOutOfTree = isOnVirtualWorkspace

  const scopedStorageUri = getScopedGlobalStorageUri(context, root)

  function resolvePath(path: string): Uri {
    let mat: RegExpMatchArray | null
    if (mat = path.match(/^\/workspace(|\/.*)$/)) {
      return Uri.joinPath(root, mat[1]!)
    }
    if (mat = path.match(/^\/gitdir(|\/.*)$/)) {
      return isCloningOutOfTree ?
        Uri.joinPath(scopedStorageUri, 'gitdir', mat[1]!) :
        Uri.joinPath(root, '.git', mat[1]!)
    }
    if (mat = path.match(/^\/store(|\/.*)$/)) {
      return Uri.joinPath(isCloningOutOfTree ? scopedStorageUri : root, mat[1]!)
    }
    throw new Error(`Could not match path prefix from: "${path}"`)
  }

  const fsp = createIsoGitAsyncFs(workspace.fs, { resolvePath })

  const isoGitBaseOpts: IsoGitBaseOptions = { fs: { promises: fsp }, http }
  if (isWeb()) {
    const config = workspace.getConfiguration('git-submodule-cloner')
    isoGitBaseOpts.corsProxy = config.get('corsProxyUrl', 'https://cors.isomorphic-git.org')
  }

  function getDirSpec(mod: GitSubmoduleSpec) {
    return isCloningOutOfTree ?
      { oot: true  as const, dir: `/store/submodules/${mod.name}`, gitdir: undefined } :
      { oot: false as const, dir: `/workspace/${mod.path}`,        gitdir: `/gitdir/modules/${mod.name}` }
  }

  return {
    isOnVirtualWorkspace,
    isCloningOutOfTree,
    resolvePath,
    getDirSpec,
    fsp,
    isoGitBaseOpts,
  }
}

type ContextExt = ReturnType<typeof makeContextFromWorkspaceFolder>

function registerCommandWithActiveWSFolder<T>(
  context: ExtensionContext,
  name: string,
  handler: (contextExt: ContextExt, uri: Uri, ...args: any[]) => Promise<T>,
  thisArg?: any) {

  context.subscriptions.push(commands.registerCommand(name, async (maybeUri?: Uri, ...args: unknown[]) => {
    const _wsfuri = maybeUri ?? maybeChooseWSFolderUri()
    const wsfuri = 'then' in _wsfuri ? await _wsfuri : _wsfuri
    if (!wsfuri) return

    const extctx = makeContextFromWorkspaceFolder(context, wsfuri)
    return handler(extctx, wsfuri, ...args)
  }, thisArg))
}

export async function activate(context: ExtensionContext): Promise<ExtensionExports> {
  function getWorkspaceAuxFolderDescs(root: Uri) {
    const uriBase = getScopedGlobalStorageUri(context, root)

    return {
      gitdir: {
        name: '⚙️ Workspace .git directory',
        uri: Uri.joinPath(uriBase, 'gitdir'),
      },
      submodules: {
        name: '⚙️ Workspace submodules',
        uri: Uri.joinPath(uriBase, 'submodules'),
      },
    }
  }

  async function mountAuxWorkspaceFolders(workspaceRoot: Uri, options?: { gitdir?: boolean }) {
    if (!workspace.workspaceFile && isWeb()) {
      const detail = 'This operation will create a new workspace in the current session. ' +
        'On VS Code for the Web, workspaces are transient and may be lost if the page is closed. Proceed?'
      const resp = await window.showInformationMessage(
        'Creating a workspace', { modal: true, detail }, 'OK')
      if (resp !== 'OK') {
        return false
      }
    }

    const descs = getWorkspaceAuxFolderDescs(workspaceRoot)

    const ok = await appendWorkspaceFolders([
      // isWeb() ?
      //   { name: 'VS Code user data', uri: vscode.Uri.parse('vscode-userdata:/') } :
      //   { name: 'Extension storage', uri: context.globalStorageUri },
      options?.gitdir && descs.gitdir,
      descs.submodules,
    ].filter(x => !!x))
    if (!ok) {
      // console.warn('updateWorkspaceFolders returns false')
    }
    return ok
  }

  interface CloneSubmoduleSpec {
    mod: GitSubmoduleSpec
    dir: string
    gitdir: string | undefined
    ref: string
  }

  async function cloneSubmodule(isoGitBaseOpts: IsoGitBaseOptions, {mod, ...spec}: CloneSubmoduleSpec) {
    let httpUrl = mod.url
    if (httpUrl.startsWith('./') || httpUrl.startsWith('../')) {
      // FIXME: handle relative URL
      throw new Error('Relative URL is not supported: ' + httpUrl)
    }
    // try to rewrite SSH URI to http
    let mat: RegExpMatchArray | null
    if (mat = mod.url.match(/^git@github\.com:([^]+)$/)) {
      httpUrl = 'https://github.com/' + mat[1]
    }

    const titleMsg = mod.path === mod.name ? `"${mod.name}"` : `"${mod.name}" to "${mod.path}"`

    await window.withProgress({
      title: `Cloning submodule ${titleMsg}`,
      location: vscode.ProgressLocation.Notification,
      cancellable: false,
    }, async (progress, _token) => {
      // TODO: if the commit exists in local, only do a checkout
      await git.clone({
        ...isoGitBaseOpts,
        url: httpUrl,
        singleBranch: true,
        depth: 1,
        // noCheckout: false,
        ...spec,
        batchSize: 128,
        nonBlocking: true,
        onProgress: createIsoGitProgressReporter(progress),
      })
    })

    return { httpUrl, titleMsg }
  }

  // auto mount if we are in a remote repository AND there is an untitled workspace
  // TODO: remember the last choice
  if (workspace.workspaceFolders?.length &&
      folderIsGitHubRemoteRepo(workspace.workspaceFolders[0]!.uri)) {

    const wsf = workspace.workspaceFolders[0]!.uri

    const shouldAutoMount = workspace.workspaceFile != null && await workspace.fs.stat(
      Uri.joinPath(getScopedGlobalStorageUri(context, wsf), 'submodules'))
        .then(() => true, () => false)
    if (shouldAutoMount) {
      const ok = await mountAuxWorkspaceFolders(wsf)
      if (ok) window.showInformationMessage(
        'Detected a virtual workspace with submodules cloned previously. It is now added to workspace.')
    }
  }

  registerCommandWithActiveWSFolder(context, 'git-submodule-cloner.checkout-submodules', async (extctx, wsfuri) => {
    const { fsp, isOnVirtualWorkspace, isCloningOutOfTree, getDirSpec, isoGitBaseOpts } = extctx

    const gitmodules = await readGitModules(fsp, '/workspace').catch(err => {
      window.showErrorMessage(err.message)
      return null
    })
    if (!gitmodules) return

    const hasInTreeGitDir = await exists(fsp, '/workspace/.git')
    let hasGitDir = await exists(fsp, '/gitdir')

    // when opening a GitHub repo on vscode.dev, we need to rebuild the .git folder
    if (isOnVirtualWorkspace && !hasInTreeGitDir && !hasGitDir) {
      let ref = undefined
      if (wsfuri.authority.length > 6 /* "github+"... */) {
        const decoded = hexToAscii(wsfuri.authority.slice(7))
        // TODO: figure out different types
        const refInfo = JSON.parse(decoded) as { v: string, ref: { type: number, id: string } }
        ref = refInfo.ref.id
      }

      await window.withProgress({
        title: 'Rebuilding .git for this workspace',
        location: vscode.ProgressLocation.Notification,
      }, progress => {
        return git.clone({
          ...isoGitBaseOpts,
          dir: '',  // unused
          gitdir: '/gitdir',
          url: 'https://github.com' + wsfuri.path,
          ref,
          singleBranch: true,
          depth: 1,
          noCheckout: true,
          onProgress: createIsoGitProgressReporter(progress),
        })
      })

      hasGitDir = true
    }

    // for reading, we prefer fallback-able so that it can be mocked
    // the "isCloningOutOfTree" does not yet make sense at this point
    // XXX: which should be honored first?
    const gitdirForReading = hasInTreeGitDir ? '/workspace/.git' : hasGitDir ? '/gitdir' : null

    if (!gitdirForReading) {
      window.showErrorMessage('Failed to probe .git folder for workspace.', { modal: true })
      return
    }

    let cnt = 0
    const total = gitmodules.length
    const failedNames: {name: string, reason: string}[] = []
    await window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Cloning ${total} ${total === 1 ? 'module' : 'modules'}`,
      cancellable: true,
    }, async (progress, token) => {
      progress.report({ message: `(0/${total})`, increment: 0 })

      for (let i = 0; i < total; i++) {
        if (token.isCancellationRequested) {
          break
        }

        const mod = gitmodules[i]!
        const oid = await findSubmoduleOid(fsp, gitdirForReading, mod.path)
        if (oid == null) throw new Error(`Could not find ref in parent project of submodule "${mod.name}"`)

        const dirSpec = getDirSpec(mod)
        if (!dirSpec.oot) {
          await fsp.mkdir(dirSpec.gitdir)
          const pathFromSubmodToGitDir = path.relative(`/${mod.path}`, `/.git/modules/${mod.name}`)
          await fsp.writeFile(
            path.join(dirSpec.dir, '.git'),
            textEncode(`gitdir: ${pathFromSubmodToGitDir}\n`))
        }

        try {
          const { httpUrl, titleMsg } = await cloneSubmodule(isoGitBaseOpts, {
            mod,
            ref: oid,
            dir: dirSpec.dir,
            gitdir: dirSpec.gitdir,
          })

          if (hasInTreeGitDir && !isCloningOutOfTree) {
            const fs = { promises: fsp }
            // record it for canonical-git compatibility
            await git.setConfig({ fs, gitdir: '/gitdir', path: `submodule.${mod.name}.active`, value: true })
            await git.setConfig({ fs, gitdir: '/gitdir', path: `submodule.${mod.name}.url`, value: httpUrl })
          }

          cnt++
          progress.report({ message: `(${cnt}/${total}) Cloned ${titleMsg}`, increment: 100 / total })
        } catch (err: any) {
          console.error(err)
          failedNames.push({ name: mod.name, reason: err.message })
          window.showErrorMessage(`Encountered error cloning "${mod.name}": ${err.message}`)
        }
      }
    })

    if (!failedNames.length) {
      window.showInformationMessage(`Successfully cloned ${cnt}/${total} ${total === 1 ? 'module' : 'modules'}.`)
    } else {
      // XXX: allow to retry with force
      window.showWarningMessage(
        `Successfully cloned ${cnt}/${total} ${total === 1 ? 'module' : 'modules'}.`,
        {
          modal: true,
          detail: `Failed submodules are: ${failedNames.map(({name, reason}) => `${name}: ${reason}`).join(', ')}`,
        })
    }

    if (isCloningOutOfTree) {
      const ok = await mountAuxWorkspaceFolders(wsfuri)
      if (ok) await commands.executeCommand('workbench.files.action.refreshFilesExplorer')
    }
  })

  registerCommandWithActiveWSFolder(context, 'git-submodule-cloner.add-submodules-to-workspace', async (_extctx, wsfuri) => {
    if (!folderIsGitHubRemoteRepo(wsfuri)) {
      return window.showErrorMessage('Selected workspace folder is not a GitHub remote repository.', { modal: true })
    }

    const descs = getWorkspaceAuxFolderDescs(wsfuri)
    if (workspace.getWorkspaceFolder(descs.submodules.uri)) {
      return window.showInformationMessage('Submodule store for this workspace was already mounted.')
    }

    const ok = await mountAuxWorkspaceFolders(wsfuri, { gitdir: true })
    if (ok) return window.showInformationMessage('Added the submodule store to the workspace.')
  })

  // TODO: factor it out so that it can be combined with git operations
  registerCommandWithActiveWSFolder(context, 'git-submodule-cloner.pick-submodules', async (extctx) => {
    const { fsp, getDirSpec } = extctx

    if (!(await fsp.stat('/workspace/.gitmodules').catch(() => null))) {
      window.showErrorMessage('No .gitmodules found')
      return
    }

    interface QuickPickItemSubmod extends QuickPickItem {
      commitHash?: string
      url: string
    }

    const itemSource = readGitModules(fsp, '/workspace')
      .then(xs => Promise.all(xs.map<Promise<QuickPickItemSubmod>>(async mod => {
        const oid = await findSubmoduleOid(fsp, '/gitdir', mod.name)
        // FIXME: distinguish cloned/checked-out in local setup
        const dirSpec = getDirSpec(mod)
        const pathToDotGit = dirSpec.gitdir ?? path.join(dirSpec.dir, '.git')
        // is this submodule ready? (not to be confused with "active")
        const dotgit = await fsp.stat(pathToDotGit).catch(() => false)
        return {
          iconPath: { id: dotgit ? 'repo' : 'dash' },
          label: mod.name,
          description: mod.name !== mod.path ? mod.path : '',
          detail: (oid ?? 'N/A') + (dotgit ? ' (cloned)' : ''),
          url: mod.url,
          commitHash: oid ?? undefined,
          buttons: [
            oid && { id: 'gotoSubmoduleUri', iconPath: { id: 'link' }, tooltip: 'Goto submodule URL' },
            oid && { id: 'copyCommitHash', iconPath: { id: 'copy' }, tooltip: 'Copy commit hash' },
          ].filter(x => !!x),
        }
      })))
      .catch(err => {
        window.showErrorMessage(err.message)
        return []
      })

    const pickingAction = new Promise<readonly QuickPickItemSubmod[] | undefined>((resolve) => {
      const qp = window.createQuickPick<QuickPickItemSubmod>()
      qp.ignoreFocusOut = true
      qp.busy = true
      qp.items = []
      qp.placeholder = 'Pick submodules...'
      qp.canSelectMany = true
      itemSource.then(xs => {
        qp.items = xs
        qp.busy = false
      })
      qp.onDidTriggerItemButton(async evt => {
        const { id } = evt.button as any
        if (id === 'copyCommitHash') {
          if (evt.item.commitHash) {
            await vscode.env.clipboard.writeText(evt.item.commitHash)
            window.showInformationMessage('Copied')
          }
        } else if (id === 'gotoSubmoduleUri') {
          if (evt.item.url) {
            const ok = await vscode.env.openExternal(Uri.parse(evt.item.url))
            if (!ok) {
              window.showErrorMessage(`Cannot goto "${evt.item.url}"`)
            }
          }
        }
      })
      qp.onDidAccept(() => {
        resolve(qp.selectedItems)
        qp.dispose()
      })
      qp.show()
    })

    const picked = await pickingAction
    window.showInformationMessage(`You picked ${picked?.map(x => x.label).join(' && ') || 'nothing'}`)
    return picked
  })

  return {}
}
