export type Question = {
  id: string
  prompt: string
  choices: string[]
  answer: number
  explanation: string
  // The file it was generated from; absent on seed questions
  file?: string
  // The difficulty it was generated at; absent on seed questions (difficulty 1)
  difficulty?: number
}

// One turn of a clarifying discussion about the question
export type Message = { from: 'you' | 'claude'; text: string }

// `guess` is a choice index, -1 for "Absolutely no idea", null before answering.
// `chat` is set once you ask a clarifying question, `draft` holds what you're typing,
// and `isThinking` is set while Claude replies.
// `issue` holds what you're typing while the "Suggest improvement or file a bug" box is open.
export type Round = {
  question: Question
  guess: number | null
  chat?: Message[]
  draft?: string
  isThinking?: boolean
  issue?: string
  // "Absolutely no idea" was pressed once: the answer waits while a clarifying question is offered
  isStumped?: boolean
}

// An issue waiting to be rephrased and written to docs/issues/todo/, with the question it came up on
export type Issue = { text: string; question: Question }

export type Skill = { difficulty: number; streak: number }

declare module 'claude-code' {
  interface PluginState {
    'brain-unrot': { round: Round | null; ready: number; skill: Skill; notice: string | null }
  }
}
