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

// One turn of a clarifying discussion about the question
export type Message = { from: 'you' | 'claude'; text: string }

// `guess` is a choice index, -1 for "Absolutely no idea", null before answering.
// `chat` is set once you ask a clarifying question, `draft` holds what you're typing,
// and `isThinking` is set while Claude replies.
export type Round = { question: Question; guess: number | null; chat?: Message[]; draft?: string; isThinking?: boolean }

export type Skill = { level: number; streak: number }

declare module 'claude-code' {
  interface PluginState {
    'brain-unrot': { round: Round | null; ready: number; skill: Skill }
  }
}
