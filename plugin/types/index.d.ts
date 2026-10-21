export type Question = {
  id: string
  prompt: string
  choices: string[]
  answer: number
  explanation: string
  // Path of the file it was generated from; absent on seed questions
  sourceFile?: string
  // The difficulty it was generated at; absent on seed questions (difficulty 1)
  difficulty?: number
}

export type Topic =
  | 'context management'
  | 'prompting'
  | 'agents and subagents'
  | 'testing and verification'
  | 'cost and model choice'
  | 'security'
  | 'IDE and CLI workflow'

// A short "did you know" item about coding with LLMs.
// `lane` is where it came from: the Claude Code CHANGELOG, open-web research, or the seed tidbits.
// `quote` is a verbatim line of the source; `isVerified` is set once it was found there.
// `version` is the Claude Code release it's about (changelog tidbits only).
// `publishedAt` and `expiresAt` are ISO dates, absent on seed tidbits.
export type Tidbit = {
  id: string
  headline: string
  body: string
  tryIt?: string
  url: string
  publishedAt?: string
  quote: string
  topic: Topic
  lane: 'changelog' | 'research' | 'seed'
  version?: string
  expiresAt?: string
  isVerified: boolean
}

// A tidbit once it's been shown, with your last reaction and whether you asked about it
export type ShownTidbit = Tidbit & { shownAt: string; reaction?: Reaction; isAsked?: boolean }

// One turn of a clarifying discussion about the question
export type Message = { from: 'you' | 'claude'; text: string }

export type Reaction = 'knew-it' | 'new-to-me' | 'not-useful'

// `chat` is set once you ask about the round, `draft` holds what you're typing,
// and `isThinking` is set while Claude replies.
// `issue` holds what you're typing while the "Suggest improvement or file a bug" box is open.
export type Shared = {
  chat?: Message[]
  draft?: string
  isThinking?: boolean
  issue?: string
}

// `guess` is a choice index, -1 for "Absolutely no idea", null before answering.
// `reaction` is null until you react to the tidbit.
export type Round =
  | (Shared & { kind: 'question'; question: Question; guess: number | null })
  | (Shared & { kind: 'tidbit'; tidbit: Tidbit; reaction: Reaction | null })

// An issue waiting to be rephrased and written to docs/issues/todo/, with the round it came up on
export type Issue = { text: string; about: { kind: 'question'; question: Question } | { kind: 'tidbit'; tidbit: Tidbit } }

export type Skill = { difficulty: number; streak: number }

// `level` is how advanced tidbits should be, 1 to 5, tuned by "Knew it" and "New to me".
// `weights` scale how often each topic comes up. `share` is the part of rounds that are tidbits.
export type Prefs = { level: number; weights: Partial<Record<Topic, number>>; share: number }

declare module 'claude-code' {
  interface PluginState {
    'brain-unrot': { round: Round | null; ready: number; tips: number; skill: Skill; notice: string | null }
  }
}
