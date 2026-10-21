export type Question = {
  id: string
  prompt: string
  choices: string[]
  answer: number
  explanation: string
  // The file it was generated from; absent on seed questions
  file?: string
  // The difficulty it was generated at; absent on seed questions (level 1)
  level?: number
}

// `guess` is a choice index, -1 for "Absolutely no idea", null before answering
export type Round = { question: Question; guess: number | null }

export type Skill = { level: number; streak: number }

declare module 'claude-code' {
  interface PluginState {
    'brain-unrot': { round: Round | null; ready: number; skill: Skill }
  }
}
