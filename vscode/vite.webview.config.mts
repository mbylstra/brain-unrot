import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The quiz UI: one self-contained file, CSS included, so it can be served anywhere later (e.g. as an MCP App)
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./webview', import.meta.url)) } },
  // Library builds leave `process.env.NODE_ENV` alone, and React reads it
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    minify: true,
    lib: { entry: 'webview/main.tsx', formats: ['iife'], name: 'brainUnrot', fileName: () => 'webview.js' },
  },
})
