import * as esbuild from 'esbuild'

/** @type {esbuild.BuildOptions} */
const commonOptions = {
  bundle: true,
  external: ['vscode'],
  entryPoints: ['src/extension.ts'],
  format: 'cjs',
  sourcemap: true,
}

/** @type {esbuild.BuildOptions} */
const desktopOptions = {
  ...commonOptions,
  target: 'es2020',
  platform: 'node',
  outfile: 'dist/desktop/extension.js',
  alias: {
    '$isogit-http': 'isomorphic-git/http/node',
    '$node-path': 'node:path',
  },
}

/** @type {esbuild.BuildOptions} */
const webOptions = {
  ...commonOptions,
  target: 'es2020',
  platform: 'browser',
  outfile: 'dist/web/extension.js',
  alias: {
    '$isogit-http': 'isomorphic-git/http/web',
    '$node-path': 'pathe',
  },
  inject: ['src/web-buffer.ts']
}

const contexts = await Promise.all([
  esbuild.context(desktopOptions),
  esbuild.context(webOptions),
])

if (process.argv[2] === '--watch') {
  const promises = [];
  for (const context of contexts) {
    promises.push(context.watch())
  }
  console.log('Watching...')
  await Promise.all(promises).then(() => {})
} else {
  const promises = []
  for (const context of contexts) {
    promises.push(context.rebuild())
  }

  await Promise.all(promises)
  for (const context of contexts) {
    await context.dispose()
  }
}
