import type { FileSystem } from 'vscode'
import { FileSystemError, FileType, Uri } from 'vscode'

// eye-balled from the codebase of isomorphic-git and lightning-fs
export interface IsoGitFileStat {
  // should be private
  type: 'file' | 'dir' | 'symlink' | string
  mode: number
  size: number
  ino: number
  mtimeMs: number
  ctimeMs: number
  uid: number
  gid: number
  dev: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

type UTF8 = 'utf8' | 'utf-8'
export interface IsoGitAsyncFsPrimitive {
  readFile(path: string): Promise<Uint8Array>
  readFile(path: string, options: UTF8): Promise<string>
  readFile(path: string, options: { encoding: UTF8 }): Promise<string>
  readFile(path: string, options?: string | { encoding?: string }): Promise<string | Uint8Array>
  writeFile(path: string, contents: string | Uint8Array, options?: string | { encoding?: string }): Promise<void>
  mkdir(path: string): Promise<void>
  rmdir: ((path: string) => Promise<void>) | ((path: string, options?: { recursive?: boolean }) => Promise<void>)
  unlink(path: string): Promise<void>
  stat(path: string): Promise<IsoGitFileStat>
  lstat(filename: string): Promise<IsoGitFileStat>
  readdir(path: string): Promise<string[]>

  // must be defined but according to doc only for repos with symlinks
  readlink(filename: string, options?: { encoding?: 'buffer' }): Promise<string | Uint8Array>
  symlink(path: string, from: string): Promise<void>

  // only used in isogit's test suite for submodules
  // cp?: undefined

  // rm will be fallbacked in the order:
  //   (1) use rmdir when rmdir can accept the second argument, Node's deprecated behavior;
  //       see https://nodejs.org/docs/latest/api/fs.html#fspromisesrmdirpath-options
  //   (2) emulated recursive rm with unlink
  // rm?: undefined
}

// note that we explicitly refuse to handle symlinks until vscode supports so:
// https://github.com/microsoft/vscode/issues/84514
class MyStat implements IsoGitFileStat {
  mode = 0
  ino = 256
  uid = 1000
  gid = 1000
  dev = 1
  constructor(
    readonly type: string,
    readonly size: number,
    readonly ctimeMs: number,
    readonly mtimeMs: number) {}

  isFile() { return this.type === 'file' }
  isDirectory() { return this.type === 'dir' }
  isSymbolicLink() { return this.type === 'symlink' }
}

class IsoGitFSError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? `IsoGitFSError: ${code}`)
  }
}

interface IsoGitAsyncFsOptions {
  // TODO: add an option to allow path resolution func to be invalidated
  // when eg. workspace dir changes; makes all further fs operations throw
  resolvePath(path: string): Uri
}

export function createIsoGitAsyncFs(vscfs: FileSystem, options: IsoGitAsyncFsOptions): IsoGitAsyncFsPrimitive {
  const textEncoder = new TextEncoder
  const textDecoder = new TextDecoder

  type WrapUriHandler<T> = T extends (uri: Uri, ...rest: infer Ps) => infer R ? (path: string, ...rest: Ps) => R : never
  type UnwrapUriHandler<T> = T extends (path: string, ...rest: infer Ps) => infer R ? (uri: Uri, ...rest: Ps) => R : never

  function wrapUriHandler<R, Ps extends unknown[]>(fn: (uri: Uri, ...rest: Ps) => Promise<R>): WrapUriHandler<typeof fn> {
    // this is so arcane because iso-git proactively tests if my fs is promise-based when binding;
    // by calling readFile() and it throws at the first place; see src/models/FileSystem.js
    const inner = async (path: string, ...rest: any): Promise<R> => {
      try {
        // XXX: can be simplified with Promise.try
        return await fn(options.resolvePath(path), ...rest)
      } catch (err) {
        if (err instanceof FileSystemError) {
          // TODO: map all fs errors
          if (err.code === 'FileNotFound') {
            throw new IsoGitFSError('ENOENT', err.message)
          }
        }
        throw err
      }
    }

    // hack to make fn.length inact
    if (fn.length === 1) return inner
    if (fn.length === 2) return ((path: string, p0: any) => inner(path, p0)) as any
    if (fn.length === 3) return ((path: string, p0: any, p1: any) => inner(path, p0, p1)) as any

    // throw new TypeError('fn accepts too many arguments')
    return (path: string, ...rest: Ps) => inner(path, ...rest)
  }

  type AsyncFsUriPrimitive = { [K in keyof IsoGitAsyncFsPrimitive]: UnwrapUriHandler<IsoGitAsyncFsPrimitive[K]> }

  const fspUri: AsyncFsUriPrimitive = {
    async readFile(uri, options) {
      const isStrUtf8 = (s: unknown) => s === 'utf8' || s === 'utf-8'
      const data = await vscfs.readFile(uri)
      const isOptUtf8 = isStrUtf8(typeof options === 'string' ? options : options?.encoding)
      return isOptUtf8 ? textDecoder.decode(data) : data
    },
    async writeFile(uri, contents: string | Uint8Array, options) {
      const data = typeof contents === 'string' ? textEncoder.encode(contents) : contents
      await vscfs.writeFile(uri, data)
    },
    async mkdir(uri) {
      await vscfs.createDirectory(uri)
    },
    async rmdir(uri: Uri) {
      // FIXME: not checking if it is a dir for atomicity
      await vscfs.delete(uri)
    },
    async unlink(uri) {
      await vscfs.delete(uri)
    },
    async stat(uri) {
      const { type, size, ctime, mtime } = await vscfs.stat(uri)
      if (type & FileType.SymbolicLink) {
        throw new IsoGitFSError('EUNSUP', 'Unsupported: should follow symlink: ' + uri.toString())
      }
      const tt = type & FileType.Directory ? 'dir' :
                 type & FileType.File ? 'file' : 'unknown'
      return new MyStat(tt, size, ctime, mtime)
    },
    async lstat(uri) {
      const { type, size, ctime, mtime } = await vscfs.stat(uri)
      const tt = type & FileType.SymbolicLink ? 'symlink' :
                 type & FileType.Directory ? 'dir' :
                 type & FileType.File ? 'file' :'unknown'
      return new MyStat(tt, size, ctime, mtime)
    },
    async readdir(uri) {
      // reduce the noise isogit makes, but loses atomicity
      const s = await vscfs.stat(uri)
      if (!(s.type & FileType.Directory)) {
        throw new IsoGitFSError('ENOTDIR')
      }
      const ents = await vscfs.readDirectory(uri)
      return ents.map(([s]) => s)
    },

    readlink: () => {
      throw new Error('readlink not implemented.')
    },
    symlink: () => {
      throw new Error('symlink not implemented.')
    },
  }

  // TODO: fix the typing
  const fsp = Object.fromEntries(
    Object.entries<any>(fspUri).map(([k, v]) => [k, wrapUriHandler(v)])) as unknown as IsoGitAsyncFsPrimitive

  return fsp
}

export async function exists(fs: IsoGitAsyncFsPrimitive, s: string) {
  try {
    await fs.stat(s)
    return true
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return false
    }
    throw err
  }
}
