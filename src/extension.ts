import type { ExtensionContext } from 'vscode'
import vscode from 'vscode'
import git, { type PromiseFsClient } from 'isomorphic-git'
import http from '$isogit-http'
import path from '$node-path'
import { createIsoGitAsyncFs } from './fs'
import { parseGitModules, type GitSubmoduleSpec } from './gitmodules'


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
  const fsp = createIsoGitAsyncFs(vscode.workspace)
  const fs: PromiseFsClient = { promises: fsp }

  const extraOpts: Record<string, string> = {}
  if (vscode.env.uiKind === vscode.UIKind.Web) {
    extraOpts.corsProxy = 'https://cors.isomorphic-git.org'
  }

  async function findAllSubmoduleLinks() {
    const oid = await git.resolveRef({ fs, dir: '/', ref: 'HEAD' })
    const obj = await git.readTree({ fs, dir: '/', oid })
    return obj.tree.filter(x => x.mode === '160000')
      .map(ent => ({...ent, uri: fsp._resolvePath(ent.path).toString()}))
  }

  context.subscriptions.push(vscode.commands.registerCommand('git-submodule-cloner.checkout-submodules', async () => {
    let gmraw: string
    try {
      // FIXME: reject if it is a symlink
      gmraw = await fsp.readFile('/.gitmodules', 'utf-8') as string
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

    let gitlinks
    try {
      gitlinks = await findAllSubmoduleLinks()
    } catch (err: any) {
      await vscode.window.showErrorMessage('Failed to find submodule gitlinks: ' + err.message)
      return
    }

    for (const mod of gitmodules.entries) {
      // finds the matching gitlink
      const uri = fsp._resolvePath(mod.path)
      const uristr = uri.toString()
      const loc = gitlinks.find(v => v.uri === uristr)
      if (!loc?.oid) throw new Error('Could not find submodule ref in parent project')

      const submodDir = '/' + mod.path
      const submodGitDir = '/.git/modules/' + mod.name
      await fsp.mkdir(submodGitDir)
      const pathFromSubmodToGitDir = path.relative(submodDir, submodGitDir)

      await vscode.workspace.fs.writeFile(uri.with({ path: uri.path + '/.git' }), new TextEncoder().encode(`gitdir: ${pathFromSubmodToGitDir}\n`))

      try {
        await cloneSubmodule(mod, submodGitDir, loc.oid, submodDir)
      } catch (err) {
        console.error(err)
        debugger
      }
    }

    async function cloneSubmodule(mod: GitSubmoduleSpec, gitdir: string, ref: string, dir: string) {
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
        title: `Cloning ${titleMsg}`,
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
      }, async (progress, _token) => {
        let percentage = 0

        let lastUpdatingWorkdir = -1
        let isUpdatingWorkdirSecondPhase = false

        progress.report({ message: 'Initializing...' })

        await git.clone({
          fs, http, ...extraOpts,
          dir,
          gitdir,
          url: httpUrl,
          ref,
          singleBranch: true,
          depth: 1,
          // noCheckout: true,
          batchSize: 128,
          nonBlocking: true,
          onProgress({phase, loaded, total}) {
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
              progress.report({ message: phase })
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
        })

        await git.setConfig({ fs, dir: '/', path: `submodule.${mod.name}.active`, value: true })
        await git.setConfig({ fs, dir: '/', path: `submodule.${mod.name}.url`, value: httpUrl })

        vscode.window.showInformationMessage(`Cloned ${titleMsg}.`)
      })
    }
  }))

  return {}
}
