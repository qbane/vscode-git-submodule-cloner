import * as git from 'isomorphic-git'
import vscode from 'vscode'
import path from '$node-path'
import http from '$isogit-http'
import type { IsoGitAsyncFsPrimitive } from './fs'
import { parseGitModules } from './gitmodules'

export interface IsoGitBaseOptions {
  fs: git.PromiseFsClient
  http: typeof http
  corsProxy?: string
}

export async function readGitModules(fsp: IsoGitAsyncFsPrimitive, dir: string) {
  const gmraw = await fsp.readFile(
    // FIXME: reject if it is a symlink
    path.join(dir, '.gitmodules'), 'utf-8').catch(err => (
      Promise.reject(new Error('Failed to read .gitmodules: ' + err.message, { cause: err }))
  ))

  const gitmodules = await parseGitModules(gmraw).catch(err => (
    Promise.reject(new Error('Failed to parse .gitmodules: ' + err.message, { cause: err }))
  ))

  if (gitmodules.errors.length) {
    const errMsg = gitmodules.errors.map(x => x.message).join('\n')
    vscode.window.showWarningMessage(`Failed to resolve the following submodule(s):\n${errMsg}`)
    // TODO: bail out?
  }

  return gitmodules.entries
}

export async function findSubmoduleOid(fs: IsoGitAsyncFsPrimitive, gitdir: string, filepath: string) {
  const oid = await git.resolveRef({ fs, gitdir, ref: 'HEAD' })
  const parent = path.dirname(filepath)
  const obj = await git.readTree({ fs, gitdir, oid, filepath: parent !== '.' ? parent : undefined })
    .then(dobj => {
      const filename = path.basename(filepath)
      const obj = dobj.tree.find(x => x.path === filename)
      return obj ?? Promise.reject()
    })
    .catch(() => Promise.reject(new Error(`"${filepath}" does not exist in HEAD`)))
  return obj.type === 'commit' ? obj.oid : null
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

type VscodeWithProgressTask = Parameters<typeof vscode.window.withProgress>[1]
type VscodeProgressContext = Parameters<VscodeWithProgressTask>[0]

export function createIsoGitProgressReporter(progress: VscodeProgressContext) {
  let percentage = 0

  let lastUpdatingWorkdir = -1
  let isUpdatingWorkdirSecondPhase = false

  progress.report({ message: 'Initializing...' })

  return async ({phase, loaded, total}: Parameters<git.ProgressCallback>[0]) => {
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
