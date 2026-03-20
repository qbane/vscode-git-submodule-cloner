import type { ExtensionContext, QuickPickItem } from 'vscode'
import vscode, { window, commands, workspace, Uri } from 'vscode'
import git, { type ProgressCallback } from 'isomorphic-git'
import http from '$isogit-http'
import path from '$node-path'
import { createIsoGitAsyncFs, exists, type IsoGitAsyncFsPrimitive } from './fs'
import { type GitSubmoduleSpec } from './gitmodules'
import { hexToAscii, textEncode } from './utils'
import { findSubmoduleOid, readGitModules, type IsoGitBaseOptions } from './gitops'

// XXX: if no checkout we may want a different set of progress estimations
const gitClonePhases: Record<string, [number, number]> = {
  'Counting objects':    [ 6,  3],
  'Compressing objects': [ 9, 12],
  'Receiving objects':   [21,  6],
  'Resolving deltas':    [27,  9],
  'Analyzing workdir':   [36, 18],
  'Updating workdir':    [54,  6],
  'Updating workdir2':   [60, 40],
}

function isVirtualWorkspace(uri: Uri) {
  return uri.scheme === 'vscode-vfs' && uri.authority.match(/^github\+?/)
}

function maybeChooseWSFolderUri(): Uri | PromiseLike<Uri | null> {
  function _inner() {
    const fos = workspace.workspaceFolders
    if (!fos?.length) {
      throw new Error('No workspace folder to work on.')
    }

    function ensureUri(uri: Uri | undefined, main = false): Uri {
      if (!uri) {
        throw new Error(`Failed to get URI of the ${main ? 'main' : 'specified'} workspace folder.`)
      }
      return uri
    }

    if (fos.length == 1) return ensureUri(fos[0]!.uri, true)

    // maybe roll my own to exclude aux dirs
    return window.showWorkspaceFolderPick({
      placeHolder: 'Choose a workspace folder to work on...'
    }).then(x => {
      return x ? ensureUri(x.uri) : null
    })
  }

  try { return _inner() } catch (err: any) {
    return window.showErrorMessage(err.message).then(() => null)
  }
}

export async function activate(context: ExtensionContext): Promise<ExtensionExports> {
  function makeContextFromWorkspaceFolder(root: Uri) {
    const isOnVirtualWorkspace = root && isVirtualWorkspace(root)

    // this is essentially equivalent as above, except that you can change it to true on desktop
    // to try out the remote repository behavior
    const isCloningOutOfTree = isOnVirtualWorkspace

    function resolvePath(path: string): Uri {
      let mat: RegExpMatchArray | null
      if (mat = path.match(/^\/workspace(|\/.*)$/)) {
        return Uri.joinPath(root, mat[1]!)
      }
      if (mat = path.match(/^\/gitdir(|\/.*)$/)) {
        return isCloningOutOfTree ?
          Uri.joinPath(context.storageUri!, 'gitdir', mat[1]!) :
          Uri.joinPath(root, '.git', mat[1]!)
      }
      if (mat = path.match(/^\/store(|\/.*)$/)) {
        return Uri.joinPath(isCloningOutOfTree ? context.storageUri! : root, mat[1]!)
      }
      throw new Error(`Could not match path prefix from: "${path}"`)
    }

    const fsp = createIsoGitAsyncFs(workspace.fs, { resolvePath })

    const isoGitBaseOpts: IsoGitBaseOptions = { fs: { promises: fsp }, http }
    if (vscode.env.uiKind === vscode.UIKind.Web) {
      isoGitBaseOpts.corsProxy = 'https://cors.isomorphic-git.org'
    }

    return {
      isOnVirtualWorkspace,
      isCloningOutOfTree,
      resolvePath,
      fsp,
      isoGitBaseOpts,
    }
  }

  function mountAuxWorkspaceFolders() {
    if (context.storageUri == null) {
      throw new Error('no workspace is set')
    }
    const ok = vscode.workspace.updateWorkspaceFolders(
      vscode.workspace.workspaceFolders?.length ?? 0, 0,
      // vscode.env.uiKind === vscode.UIKind.Web ?
      //   { name: 'VS Code user data', uri: vscode.Uri.parse('vscode-userdata:/') } :
      //   { name: 'Extension storage', uri: context.globalStorageUri },
      { name: 'Workspace .git directory', uri: Uri.joinPath(context.storageUri, 'gitdir') },
      { name: 'Workspace submodules', uri: Uri.joinPath(context.storageUri, 'submodules') },
    )
    if (!ok) {
      // console.warn('updateWorkspaceFolders returns false')
    }
    commands.executeCommand('revealInExplorer', context.storageUri)
  }

  type VscodeWithProgressTask = Parameters<typeof window.withProgress>[1]
  type VscodeProgressContext = Parameters<VscodeWithProgressTask>[0]

  function createIsoGitProgressReporter(progress: VscodeProgressContext) {
    let percentage = 0

    let lastUpdatingWorkdir = -1
    let isUpdatingWorkdirSecondPhase = false

    progress.report({ message: 'Initializing...' })

    return async ({phase, loaded, total}: Parameters<ProgressCallback>[0]) => {
      let cur = percentage
      let phase_ = phase

      // updating workdir has two phases;
      // we switch to the next one upon seeing the process report rewind
      if (phase == 'Updating workdir') {
        if (isUpdatingWorkdirSecondPhase || (lastUpdatingWorkdir >= 0 && loaded < lastUpdatingWorkdir)) {
          isUpdatingWorkdirSecondPhase = true
          phase_ = 'Updating workdir2'
        } else {
          lastUpdatingWorkdir = loaded
        }
      }

      const curPhase = gitClonePhases[phase_]
      if (!curPhase) {
        progress.report({ message: loaded != null ? `${phase}... (${loaded})` : phase })
      } else {
        let msg
        const [base, span] = curPhase
        if (loaded != null && total) {
          const frac = Math.min(loaded / total, 1)
          cur = base + span * frac
          msg = `${phase}... (${(frac * 100).toFixed(1)}%, ${loaded}/${total})`
        } else {
          cur = base + span * .5
          msg = loaded != null ? `${phase}... (${loaded})` : phase
        }

        progress.report({ message: msg, increment: Math.max(0, cur - percentage) })
        percentage = cur
      }
    }
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

  context.subscriptions.push(commands.registerCommand('git-submodule-cloner.checkout-submodules', async (maybeUri?: Uri) => {
    const _wsfuri = maybeUri ?? maybeChooseWSFolderUri()
    const wsfuri = 'then' in _wsfuri ? await _wsfuri : _wsfuri
    if (!wsfuri) return

    const { isoGitBaseOpts, isOnVirtualWorkspace, isCloningOutOfTree, fsp } = makeContextFromWorkspaceFolder(wsfuri)

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
        cancellable: false,
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
    const gitdirForReading = hasInTreeGitDir ? '/workspace/.git' : '/gitdir'

    for (const mod of gitmodules) {
      const oid = await findSubmoduleOid(fsp, gitdirForReading, mod.path)
      if (oid == null) throw new Error(`Could not find ref in parent project of submodule "${mod.name}"`)

      const dirSpec = isCloningOutOfTree ?
        { oot: true  as const, dir: `/store/submodules/${mod.name}`, gitdir: undefined } :
        { oot: false as const, dir: `/workspace/${mod.path}`,        gitdir: `/gitdir/modules/${mod.name}` }

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

        window.showInformationMessage(`Cloned submodule ${titleMsg}.`)
      } catch (err: any) {
        console.error(err)
        window.showErrorMessage(`Encountered error cloning "${mod.name}": ${err.message}`)
      }
    }

    if (isCloningOutOfTree) {
      mountAuxWorkspaceFolders()
    }
  }))

  context.subscriptions.push(commands.registerCommand('git-submodule-cloner.add-submodules-to-workspace', async () => {
    if (context.storageUri == null) {
      window.showErrorMessage('No workspace is opened.')
      return
    }

    if (workspace.getWorkspaceFolder(context.storageUri)) {
      window.showInformationMessage('Submodule store for this workspace was already mounted.')
      return
    }

    mountAuxWorkspaceFolders()
    window.showInformationMessage('Added the submodule store to the workspace.')
  }))

  return {}
}
