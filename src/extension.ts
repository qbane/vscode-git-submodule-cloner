import type { ExtensionContext } from 'vscode'
import vscode, { workspace, Uri } from 'vscode'
import git, { type ProgressCallback } from 'isomorphic-git'
import http from '$isogit-http'
import path from '$node-path'
import { createIsoGitAsyncFs, exists, type IsoGitAsyncFsPrimitive } from './fs'
import { parseGitModules, type GitSubmoduleSpec } from './gitmodules'
import { hexToAscii } from './utils'

async function findAllSubmoduleLinks(fs: IsoGitAsyncFsPrimitive, gitdir: string) {
  const oid = await git.resolveRef({ fs, gitdir, ref: 'HEAD' })
  const obj = await git.readTree({ fs, gitdir, oid })
  return obj.tree.filter(x => x.mode === '160000')
}

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

export async function activate(context: ExtensionContext): Promise<ExtensionExports> {
  // FIXME: allow selecting a non-first workspace folder
  const mainWSUri = workspace.workspaceFolders?.[0]?.uri

  const isOnVirtualWorkspace = (mainWSUri &&
    mainWSUri.scheme === 'vscode-vfs' &&
    mainWSUri.authority.match(/^github\+?/))

  // this is essentially equivalent as above, except that you can change it to true on desktop
  // to try out the remote repository behavior
  const isCloningOutOfTree = isOnVirtualWorkspace

  function resolvePath(path: string): Uri {
    // FIXME: handle multiple workspace folders
    const root = workspace.workspaceFolders?.[0]?.uri
    if (!root) {
      throw new Error('no workspace root set')
    }

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
  const fs = { promises: fsp }

  const extraOpts: Record<string, string> = {}
  if (vscode.env.uiKind === vscode.UIKind.Web) {
    extraOpts.corsProxy = 'https://cors.isomorphic-git.org'
  }

  function mountAuxWorkspaceFolder() {
    if (context.storageUri == null) {
      throw new Error('no workspace is set')
    }
    const ok = vscode.workspace.updateWorkspaceFolders(
      vscode.workspace.workspaceFolders?.length ?? 0, 0,
      // vscode.env.uiKind === vscode.UIKind.Web ?
      //   { name: 'VS Code user data', uri: vscode.Uri.parse('vscode-userdata:/') } :
      //   { name: 'Extension storage', uri: context.globalStorageUri },
      { name: 'Workspace submodules', uri: context.storageUri },
    )
    if (!ok) {
      // console.warn('updateWorkspaceFolders returns false')
    }
  }

  type VscodeWithProgressTask = Parameters<typeof vscode.window.withProgress>[1]
  type VscodeProgressContext = Parameters<VscodeWithProgressTask>[0]

  function createProgressReporter(progress: VscodeProgressContext) {
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

  context.subscriptions.push(vscode.commands.registerCommand('git-submodule-cloner.checkout-submodules', async () => {
    let gmraw: string
    try {
      // FIXME: reject if it is a symlink
      gmraw = await fsp.readFile('/workspace/.gitmodules', 'utf-8') as string
    } catch (err: any) {
      if (err?.code === 'FileNotFound') {
        await vscode.window.showErrorMessage('No .gitmodules discovered.')
        return
      }
      throw err
    }

    let gitmodules
    try {
      gitmodules = await parseGitModules(gmraw)
    } catch (err: any) {
      await vscode.window.showErrorMessage('Failed to parse .gitmodules: ' + err.message)
      return
    }

    if (gitmodules.errors.length) {
      const errMsg = gitmodules.errors.map(x => x.message).join('\n')
      vscode.window.showWarningMessage(`Failed to resolve the following submodule(s):\n${errMsg}`)
      // TODO: bail out?
    }

    const hasInTreeGitDir = await exists(fsp, '/workspace/.git')
    let hasGitDir = await exists(fsp, '/gitdir')

    // when opening a GitHub repo on vscode.dev, we need to rebuild the .git folder
    if (isOnVirtualWorkspace && !hasInTreeGitDir && !hasGitDir) {
      let ref = undefined
      if (mainWSUri.authority.length > 6 /* "github+"... */) {
        const decoded = hexToAscii(mainWSUri.authority.slice(7))
        // TODO: figure out different types
        const refInfo = JSON.parse(decoded) as { v: string, ref: { type: number, id: string } }
        ref = refInfo.ref.id
      }

      await vscode.window.withProgress({
        title: 'Rebuilding .git for this workspace',
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
      }, progress => {
        return git.clone({
          fs, http, ...extraOpts,
          dir: '',  // unused
          gitdir: '/gitdir',
          url: 'https://github.com' + mainWSUri.path,
          ref,
          singleBranch: true,
          depth: 1,
          noCheckout: true,
          onProgress: createProgressReporter(progress),
        })
      })

      hasGitDir = true
    }

    let gitlinks
    try {
      // for reading, we prefer fallback-able so that it can be mocked
      // the "isCloningOutOfTree" does not yet make sense at this point
      // XXX: which should be honored first?
      const gitdir = hasInTreeGitDir ? '/workspace/.git' : '/gitdir'
      gitlinks = await findAllSubmoduleLinks(fsp, gitdir)
    } catch (err: any) {
      await vscode.window.showErrorMessage('Failed to find submodule gitlinks: ' + err.message)
      return
    }

    for (const mod of gitmodules.entries) {
      // finds the matching gitlink
      const pathToSubmod = path.join('/', mod.path)
      const loc = gitlinks.find(v => path.join('/', v.path) === pathToSubmod)
      if (!loc?.oid) throw new Error('Could not find submodule ref in parent project')

      const dirSpec = isCloningOutOfTree ?
        { oot: true  as const, dir: `/store/submodules/${mod.name}`, gitdir: undefined } :
        { oot: false as const, dir: `/workspace/${mod.path}`,        gitdir: `/gitdir/modules/${mod.name}` }

      if (!dirSpec.oot) {
        await fsp.mkdir(dirSpec.gitdir)
        const pathFromSubmodToGitDir = path.relative(`/${mod.path}`, `/.git/modules/${mod.name}`)
        await fsp.writeFile(
          path.join(dirSpec.dir, '.git'),
          new TextEncoder().encode(`gitdir: ${pathFromSubmodToGitDir}\n`))
      }

      try {
        await cloneSubmodule({
          mod,
          ref: loc.oid,
          dir: dirSpec.dir,
          gitdir: dirSpec.gitdir,
        })
      } catch (err) {
        console.error(err)
        debugger
      }
    }

    interface CloneSubmoduleSpec {
      mod: GitSubmoduleSpec
      dir: string
      gitdir: string | undefined
      ref: string
    }

    async function cloneSubmodule({mod, ...spec}: CloneSubmoduleSpec) {
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

      const titleMsg = mod.path === mod.name ? `"${mod.path}/"` : `"${mod.name}" to "${mod.path}/"`

      await vscode.window.withProgress({
        title: `Cloning submodule ${titleMsg}`,
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
      }, async (progress, _token) => {
        await git.clone({
          fs, http, ...extraOpts,
          url: httpUrl,
          singleBranch: true,
          depth: 1,
          // noCheckout: false,
          ...spec,
          batchSize: 128,
          nonBlocking: true,
          onProgress: createProgressReporter(progress),
        })
      })

      if (hasInTreeGitDir && !isCloningOutOfTree) {
        // record it for canonical-git compatibility
        await git.setConfig({ fs, gitdir: '/gitdir', path: `submodule.${mod.name}.active`, value: true })
        await git.setConfig({ fs, gitdir: '/gitdir', path: `submodule.${mod.name}.url`, value: httpUrl })
      }

      vscode.window.showInformationMessage(`Cloned submodule ${titleMsg}.`)
    }

    // if (vscode.env.uiKind === vscode.UIKind.Web) {
    mountAuxWorkspaceFolder()
    // }
  }))

  context.subscriptions.push(vscode.commands.registerCommand('git-submodule-cloner.add-submodules-to-workspace', async () => {
    if (context.storageUri == null) {
      vscode.window.showErrorMessage('No workspace is opened.')
      return
    }

    if (workspace.getWorkspaceFolder(context.storageUri)) {
      vscode.window.showInformationMessage('Submodule store for this workspace was already mounted.')
      return
    }

    mountAuxWorkspaceFolder()
    vscode.window.showInformationMessage('Added the submodule store to the workspace.')
  }))

  return {}
}
