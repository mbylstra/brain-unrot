export type Round = { answer: number; guess: number | null }

declare module 'claude-code' {
  interface PluginState {
    'brain-unrot': { round: Round | null }
  }
}
