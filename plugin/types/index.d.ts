export type LastPrompt = string | null

declare module 'claude-code' {
  interface PluginState {
    'brain-unrot': { lastPrompt: LastPrompt }
  }
}
