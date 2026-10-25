import { defineConfig } from 'vitest/config'

// Separate from the Vite build configs, so the tests don't load the webview's plugins
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
