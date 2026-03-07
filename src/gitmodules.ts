import { GitConfig } from 'isomorphic-git/managers'

export interface GitSubmoduleSpec {
  name: string
  path: string
  url: string
}

type GitModuleParseResult = {
  entries: GitSubmoduleSpec[]
  errors: Error[]
}

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

// ref: https://git-scm.com/docs/gitmodules
// optional keys are update, branch, fetchRecurseSubmodules, ignore, shallow
export async function parseGitModules(s: string): Promise<GitModuleParseResult> {
  const config = GitConfig.from(s)

  const subsections = await config.getSubsections('submodule')
  const results = await Promise.allSettled(subsections.map(async name => {
    const [path, url] = await Promise.all([
      config.get<string | null>(`submodule.${name}.path`),
      config.get<string | null>(`submodule.${name}.url`),
    ])
    if (!path) throw new Error(`Path is empty: ${name}`)
    if (!url) throw new Error(`URL is empty: ${name}`)
    return {name, path, url}
  }))

  const {fulfilled, rejected} = groupBy(results, r => r.status)
  return {
    entries: (fulfilled ?? []).map(x => (x as PromiseFulfilledResult<GitSubmoduleSpec>).value),
    errors: (rejected ?? []).map(x => (x as PromiseRejectedResult).reason as Error),
  }
}
