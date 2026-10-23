import * as esbuild from 'esbuild'

const isWatch = process.argv.includes('--watch')

const builds = [
  // The extension runs in VS Code's Node host; `vscode` is supplied at runtime
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  // The quiz UI: one self-contained file, CSS included, so it can be served anywhere later (e.g. as an MCP App)
  {
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    loader: { '.css': 'text' },
  },
]

for (const options of builds) {
  const context = await esbuild.context({ bundle: true, sourcemap: isWatch, minify: !isWatch, logLevel: 'info', ...options })
  if (isWatch) await context.watch()
  else {
    await context.rebuild()
    await context.dispose()
  }
}
