import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

// The extension runs in VS Code's Node host; `vscode` is supplied at runtime. Everything else is
// bundled in, since the .vsix ships no node_modules
export default defineConfig({
  build: {
    ssr: 'src/extension.ts',
    outDir: 'dist',
    emptyOutDir: false,
    target: 'node20',
    minify: true,
    rolldownOptions: {
      external: ['vscode', ...builtinModules, ...builtinModules.map(m => `node:${m}`)],
      output: { format: 'cjs', entryFileNames: 'extension.js' },
    },
  },
  ssr: { noExternal: true },
})
