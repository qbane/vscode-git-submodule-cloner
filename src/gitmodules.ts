import { GitConfig } from 'isomorphic-git/managers'
import type { GitSubmoduleSpec, GitModuleParseResult } from './types'

function groupBy<K extends PropertyKey, T>(
  items: Iterable<T>, selector: (item: T, index: number) => K): Partial<Record<K, T[]>> {
  const ret = {} as Record<K, T[]>
  Array.from(items).forEach((it, idx) => {
    const s = selector(it, idx)
    ret[s] ??= []
    ret[s].push(it)
  })
  return ret
}

class GitModuleParseError extends Error {
  constructor(message: string, readonly name: string) { super(message) }
}

// according to git's check_submodule_name in submodule-config.c, name has to be a valid path component;
// furthermore we try to be more pedantic to prevent messing up path handling if a user passes in a malicious .gitmodule
// see https://git-scm.com/docs/git-config#Documentation/git-config.txt-submodulePathConfig
function sanitizeGitSubmoduleSpec(name: string, path: string): { name: string, path: string } {
  function cleanUpPath(p: string, isName: boolean) {
    // see is_xplatform_dir_sep
    const comps = p.split(/(?:\/|\\)+/)
    const result: string[] = []

    for (const comp of comps) {
      if (comp === '' || comp === '.') continue
      if (comp === '..') {
        throw new GitModuleParseError(`${isName ? 'Name' : 'Path'} component cannot contain "..": ${p}`, name)
      }
      result.push(comp)
    }

    return result.join('/')
  }

  return {
    name: cleanUpPath(name, true),
    path: cleanUpPath(path, false),
  }
}

// ref: https://git-scm.com/docs/gitmodules
// optional keys are: update, branch, fetchRecurseSubmodules, ignore, shallow
export async function parseGitModules(s: string): Promise<GitModuleParseResult> {
  const config = GitConfig.from(s)

  const subsections = await config.getSubsections('submodule')
  const results = await Promise.allSettled(subsections.map(async (name, idx) => {
    if (!name) throw new GitModuleParseError(`Name is empty for submodule #${idx + 1}`, name)
    const [path, url] = await Promise.all([
      config.get<string | null>(`submodule.${name}.path`),
      config.get<string | null>(`submodule.${name}.url`),
    ])
    if (!path) throw new GitModuleParseError(`Path is empty: ${name}`, name)
    if (!url) throw new GitModuleParseError(`URL is empty: ${name}`, name)

    const sanitized = sanitizeGitSubmoduleSpec(name, path)

    return {
      name: sanitized.name,
      ...(name !== sanitized.name ? { nameRaw: name } : {}),
      path: sanitized.path,
      url,
    }
  }))

  const {fulfilled, rejected} = groupBy(results, r => r.status)
  return {
    entries: (fulfilled ?? []).map(x => (x as PromiseFulfilledResult<GitSubmoduleSpec>).value),
    errors: (rejected ?? []).map(x => (x as PromiseRejectedResult).reason as Error),
  }
}
