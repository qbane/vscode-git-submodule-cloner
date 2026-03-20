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
