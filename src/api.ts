import git from 'isomorphic-git'
import http from '$isogit-http'
import type { ExtensionExports, GitCloneOptions, RefEntry, ServerRefInfo } from './types'
import { getCorsProxyURL } from './vsc-utils'
import { FileType, Uri, workspace } from 'vscode'
import { createIsoGitAsyncFs } from './fs'
import { createIsoGitProgressReporter } from './gitops'
import { getWorkspaceId } from './vendor/workspace-id'


export async function fetchServerRefInfo(url: string): Promise<ServerRefInfo> {
  const refs = await git.listServerRefs({
    http,
    corsProxy: getCorsProxyURL(),
    url,
    protocolVersion: 1,
    symrefs: true,
  })

  let HEAD: string | undefined = undefined
  const branches: RefEntry[] = []
  const tags: RefEntry[] = []
  const REFS_HEADS = 'refs/heads/'

  refs.forEach(({ref, oid, target}) => {

    let mat: RegExpMatchArray | null
    if (ref === 'HEAD') {
      if (HEAD != null) {
        throw new Error('Duplicate HEAD entries in server response')
      }
      if (target?.startsWith(REFS_HEADS)) {
        HEAD = target.slice(REFS_HEADS.length)
      }
    } else if (ref.startsWith(REFS_HEADS)) {
      branches.push({ name: ref.slice(REFS_HEADS.length), oid })
    } else if (mat = ref.match(/^refs\/tags\/([^]+)$/)) {
      tags.push({ name: mat[0]!, oid })
    }
  })

  return { HEAD, branches, tags }
}

export async function gitClone(url: string, dest: Uri, ref?: string, options?: GitCloneOptions) {
  if (!((await workspace.fs.stat(dest)).type & FileType.Directory)) {
    throw new Error(`URI "${dest.toString()}" does not point to a directory`)
  }

  // create a fs mapping the destination to the virtual root
  // XXX: make sure it is safe from arbitrary directory traversal
  const fsp = createIsoGitAsyncFs(workspace.fs, {
    resolvePath: path => {
      return Uri.joinPath(dest, path)
    }
  })

  const onProgress = options?.onProgress ?
    createIsoGitProgressReporter({ report: options.onProgress }) :
    undefined

  return git.clone({
    fs: { promises: fsp },
    http,
    corsProxy: getCorsProxyURL(),
    dir: '/',
    url,
    ref,
    ...(options?.shallow && { singleBranch: true, depth: 1 }),
    onProgress,
    nonBlocking: true,
    batchSize: 128,
  })
}

const API: ExtensionExports = {
  getWorkspaceId,
  fetchServerRefInfo,
  gitClone,
}

export default API
