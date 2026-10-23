// Ported from plugin/hooks/register.tsx. The atoms become `state`, and the key handlers from
// the `ui.render` hook become actions the panel sends. One Quiz per workspace folder.
//
// Storage differs from the plugin: codebase and instruction questions, and the answered list for
// them, are kept in the project (`host.project`). Concept questions are general knowledge, so they
// and their answered list are kept globally (`host.global`), tagged with the project they were
// written for; any project can use them
import type { Host, Store } from '../host'
import type { Category, CategoryWeights, ConceptTopic, Issue, Message, Question, QuizPrefs, Reaction, Round, Skill } from './types'
import { askClaude, random } from './claude'
import { SEEDS } from './seeds'
import { askAboutTidbit, installedVersion, nextTidbit, react, refresh, sourceLine, tidbitsReady } from './tidbits'

const MODEL = 'haiku'
const QUEUE_MAX = 30
// Prompts answered right or skipped that are remembered, and how many of them generation is told to avoid
const ANSWERED_MAX = 200
const AVOID_MAX = 50
// Below this many ready questions, generate some about the repo as a whole
const QUEUE_LOW = 5
export const TICK_MS = 3000
// How often to check for a clarifying question waiting for a reply, or an issue to file
export const CHAT_TICK_MS = 1000
export const ISSUES_DIR = 'docs/issues/todo'
const RETRY_MS = 60_000
// Concept questions are about programming in general, so they're worth a stronger model.
// Below this many ready at your difficulty, generate some
const CONCEPT_MODEL = 'sonnet'
const CONCEPT_BUDGET_USD = 1
const CONCEPTS_LOW = 2
// Questions read the code and its git history: Bash is limited to reading git history
const CODE = { model: MODEL, tools: ['Read', 'Grep', 'Glob', 'Bash'], allowed: ['Bash(git log:*)', 'Bash(git show:*)', 'Bash(git blame:*)'] }
// Concept questions only glance at the project's manifests to see what it's built with
const CONCEPT = { model: CONCEPT_MODEL, tools: ['Read', 'Grep', 'Glob'], budget: CONCEPT_BUDGET_USD }
// Instruction questions are about what the project tells coding agents (CLAUDE.md, AGENTS.md, skills).
// Below this many ready at your difficulty, generate some, if the project has any instruction files
const INSTRUCTIONS_LOW = 2
// How often to look again for instruction files, and how many are sent with each top-up:
// the root files and a random few of the rest, so the model has reads left to follow imports
const INSTRUCTIONS_RECHECK_MS = 60_000
const INSTRUCTIONS_SAMPLE = 5
// They read the instruction files and the files those import: no Bash
const INSTRUCTIONS = { model: MODEL, tools: ['Read', 'Grep', 'Glob'] }
// The quiz chat and issue filing may also edit files in the repo, e.g. to update a plan the developer asks about
const EDIT = { ...CODE, tools: [...CODE.tools, 'Edit', 'Write'], allowed: [...CODE.allowed, 'Edit(./**)'] }
// The guess recorded for "Absolutely no idea"
export const NO_IDEA = -1
const DIFFICULTY_MIN = 1
export const DIFFICULTY_MAX = 5
// Right answers in a row that move the difficulty up one
const STREAK_UP = 3
// How often moving on from a question about a file asks whether you'd like more about it.
// Saying yes generates more when fewer than this many are ready at your difficulty
const OFFER_CHANCE = 0.5
const MORE_ABOUT_FILE_LOW = 2
// How often moving on asks which kind of round you'd like more of
const PREFERENCE_CHANCE = 0.1

export const CATEGORIES: [Category, string][] = [
  ['codebase', 'Questions about files in this project'],
  ['concept', 'General programming questions'],
  ['instructions', "Questions about the project's instructions for Claude (CLAUDE.md, AGENTS.md, skills)"],
  ['tidbit', '"Did you know" tidbits'],
]

// The instruction files at the repo root, and where skills, subagents and commands live:
// each skill is a folder with a SKILL.md, each subagent or command one .md file
const INSTRUCTION_FILE_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']
const SKILL_DIRS = ['.claude/skills', '.agents/skills']
const AGENT_DIRS = ['.claude/agents', '.claude/commands']

const isInstructionFile = (path: string) => {
  const name = path.split('/').at(-1)!
  return (
    INSTRUCTION_FILE_NAMES.includes(name) || name === 'SKILL.md' || (name.endsWith('.md') && AGENT_DIRS.some(dir => `/${path}`.includes(`/${dir}/`)))
  )
}

const DIFFICULTIES: Record<number, string> = {
  1: 'extremely easy: answerable from names alone, e.g. which folder holds the tests, what a file is for',
  2: 'easy: what a function returns, what a constant is for',
  3: 'medium: how two parts connect, which case a branch handles',
  4: 'hard: why the code is written this way, what breaks if something changes',
  5: 'expert: subtle behaviour, edge cases, interactions across several files',
}

const CONCEPT_DIFFICULTIES: Record<number, string> = {
  1: 'extremely easy: a well-known term or principle, e.g. what a unit test is for',
  2: 'easy: when to reach for a common tool or pattern',
  3: 'medium: the trade-offs between two approaches',
  4: 'hard: why a practice exists, what goes wrong without it',
  5: 'expert: subtle failure modes, interactions between systems under load or at scale',
}

const INSTRUCTION_DIFFICULTIES: Record<number, string> = {
  1: 'extremely easy: which file or skill covers what, e.g. which skill is for the frontend',
  2: 'easy: a rule or command stated plainly, e.g. which command runs the tests',
  3: 'medium: when a rule, skill or subagent applies, and how the files import or point to each other',
  4: 'hard: why a rule exists, what goes wrong if the agent ignores it',
  5: 'expert: which instruction wins when files disagree, cases the instructions leave open',
}

// What each concept topic covers, and how often it comes up: the project's own stack leads
const CONCEPT_TOPICS: [ConceptTopic, string, number][] = [
  [
    "the project's languages and frameworks",
    'the core concepts of the languages and frameworks the project uses: their execution, concurrency and memory models, type systems, and the idioms and patterns they encourage',
    3,
  ],
  ['frontend', 'frontend: rendering, state management, performance, accessibility', 1],
  ['backend', 'backend: APIs, data stores, caching, concurrency, error handling', 1],
  ['security', 'security: authentication, authorization, injection, secrets, the OWASP top 10', 1],
  ['infrastructure and deployment', 'infrastructure and deployment: CI/CD, containers, observability, scaling, reliability', 1],
  ['architecture and design', 'architecture and design: modularity, coupling, boundaries, distributed-systems trade-offs', 1],
  ['general best practices', 'general best practices, independent of language: testing, naming, code review, refactoring, version control', 1],
]

// What the panel shows. `isClaudeReady` is set when Claude finished its turn and the round you
// were on has ended: the panel says so in place of the next question
export type QuizState = {
  round: Round | null
  ready: number
  tips: number
  skill: Skill
  notice: string | null
  isAskingPreference: boolean
  isClaudeReady: boolean
}

// What the panel sends back. They mirror the plugin pane's key handlers
export type Action =
  | { type: 'choose'; index: number }
  | { type: 'skip' }
  | { type: 'next' }
  | { type: 'keepGoing' }
  | { type: 'ask' }
  | { type: 'send'; text: string }
  | { type: 'report' }
  | { type: 'submitIssue'; text: string }
  | { type: 'cancelIssue' }
  | { type: 'react'; reaction: Reaction }
  | { type: 'prefer'; category?: Category }
  | { type: 'moreAboutFile'; isYes: boolean }

// Models (and the seeds) put the right answer first far too often
function shuffle(q: Question): Question {
  const order = q.choices.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    const j = random(i + 1)
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  return { ...q, choices: order.map(i => q.choices[i]!), answer: order.indexOf(q.answer) }
}

const said = (prompt: string) => prompt.trim().toLowerCase().replace(/\s+/g, ' ')

const difficultyOf = (s: Skill) => Math.floor(s.difficulty)
const fits = (q: Question, s: Skill) => (q.difficulty ?? DIFFICULTY_MIN) <= difficultyOf(s)
const isConcept = (q: Question) => q.category === 'concept'
const categoryOf = (q: Question) => q.category ?? 'codebase'

// `helped` is a right answer after a clarifying discussion: it doesn't move the difficulty
type Outcome = 'right' | 'wrong' | 'no-idea' | 'helped'

export function stepped(s: Skill, outcome: Outcome): Skill {
  const clamp = (n: number) => Math.min(DIFFICULTY_MAX, Math.max(DIFFICULTY_MIN, n))
  if (outcome === 'no-idea') return { difficulty: clamp(s.difficulty - 1), streak: 0 }
  if (outcome === 'wrong') return { difficulty: clamp(s.difficulty - 0.5), streak: 0 }
  if (outcome === 'helped') return s
  return s.streak + 1 >= STREAK_UP ? { difficulty: clamp(s.difficulty + 1), streak: 0 } : { ...s, streak: s.streak + 1 }
}

// The categories in a random order, each picked in turn by weight from those left.
// A category weighted 0 is left out
export function weightedOrder(weights: CategoryWeights): Category[] {
  const left = CATEGORIES.map(([c]) => c).filter(c => weights[c] > 0)
  const order: Category[] = []
  while (left.length > 0) {
    let r = random(left.reduce((sum, c) => sum + weights[c], 0))
    const i = left.findIndex(c => (r -= weights[c]) < 0)
    order.push(...left.splice(i < 0 ? left.length - 1 : i, 1))
  }
  return order
}

// The same file, whether it's the absolute path Claude read or a question's relative sourceFile
const sameFile = (root: string, a: string, b: string) => {
  const relative = (path: string) => (path.startsWith(root + '/') ? path.slice(root.length + 1) : path)
  return relative(a) === relative(b)
}

const FORMAT = `Each question must have exactly 4 choices and exactly one correct answer, and be answerable from the code. Keep questions and choices short; put identifiers in backticks. Name things in full words, not by a bare identifier: say "the seed questions", not "the seeds".

Reply with JSON only, no prose and no code fence:
[{"prompt": "...", "choices": ["...", "...", "...", "..."], "answer": <index of the correct choice>, "explanation": "<one sentence>", "sourceFile": "<path of the file it is about, relative to the repo root>"}]`

// Questions waiting in the queue, and ones already answered right
const avoiding = (queue: Question[], answered: string[]) => {
  const prompts = [...queue.map(q => q.prompt), ...answered.slice(-AVOID_MAX)]
  return prompts.length === 0 ? '' : `\n\nDon't repeat these questions:\n${prompts.map(p => `- ${p}`).join('\n')}`
}

const aimAt = (difficulty: number, levels = DIFFICULTIES) =>
  `Difficulty: ${difficulty} of ${DIFFICULTY_MAX}, ${levels[difficulty]}. Keep every question at this difficulty.`

const HISTORY = 'You may run `git log`, `git show` and `git blame` to see how and why the code got this way.'

const FILE_PROMPT = (file: string, difficulty: number, avoid: string) => `You write quiz questions that help a developer learn the codebase they work in.

Read ${file} and write 2 multiple-choice questions about what it does or how it fits together. ${HISTORY}

${aimAt(difficulty)}

${FORMAT}${avoid}`

const REPO_PROMPT = (difficulty: number, avoid: string) => `You write quiz questions that help a developer learn the codebase they work in, which is the current directory.

Look around the repository (read at most 5 files), then write 4 multiple-choice questions: some about the overall architecture (what lives where, how the parts connect) and some about specific code. ${HISTORY}

${aimAt(difficulty)}

${FORMAT}${avoid}`

const CONCEPT_PROMPT = (focus: string, difficulty: number, avoid: string) => `You write quiz questions that keep a developer's general programming knowledge sharp. The project they work on is the current directory.

Glance at its manifests and config (e.g. \`package.json\`, \`pyproject.toml\`, \`go.mod\`, \`Cargo.toml\`, \`Dockerfile\`; read at most 3 files) to see which languages, frameworks and infrastructure it uses. Don't quiz them on the project's own code.

Topic: ${focus}.

Write 3 multiple-choice questions on this topic, leaning towards the languages and frameworks the project uses where they fit. Ask about high-level concepts, trade-offs and best practices: why something works the way it does, when to reach for it, what goes wrong without it. Never ask about syntax, API or function names, signatures or flags: those are quick to look up and not worth memorising.

${aimAt(difficulty, CONCEPT_DIFFICULTIES)}

Each question must have exactly 4 plausible choices and exactly one correct answer. Keep questions and choices short; put identifiers in backticks.

Reply with JSON only, no prose and no code fence:
[{"prompt": "...", "choices": ["...", "...", "...", "..."], "answer": <index of the correct choice>, "explanation": "<one or two sentences>"}]${avoid}`

const IMPORTS = `Follow what they point to, staying inside the repository: a line \`@path/to/file\` imports that file into the instructions, with the path relative to the file it's in (skip imports from the home directory, \`@~/...\`). A file the instructions tell the agent to read, and a skill's own reference files, count too. An \`@\` inside a code block, or in front of a package name such as \`@types/node\`, is not an import.`

const INSTRUCTIONS_FORMAT = `Each question must have exactly 4 choices and exactly one correct answer, and be answerable from the instruction files. Keep questions and choices short; put file names, commands and identifiers in backticks.

Reply with JSON only, no prose and no code fence:
[{"prompt": "...", "choices": ["...", "...", "...", "..."], "answer": <index of the correct choice>, "explanation": "<one sentence>", "sourceFile": "<path of the instruction file it is about, relative to the repo root; leave it out for a question about the instructions as a whole>"}]`

const INSTRUCTIONS_INTRO =
  'You write quiz questions that help a developer know what their project tells coding agents like Claude: the rules the agent must follow, the commands it should run, which skill, subagent or command is for which job, and why.'

const INSTRUCTIONS_PROMPT = (files: string[], difficulty: number, avoid: string) => `${INSTRUCTIONS_INTRO} The project is the current directory.

Its instruction files for coding agents are:
${files.map(f => `- ${f}`).join('\n')}

There may also be \`CLAUDE.md\` or \`AGENTS.md\` files in subdirectories, which apply when working there. Read the instruction files (at most 8 files in all). ${IMPORTS}

Write 3 multiple-choice questions: at least one about the instructions as a whole, drawing on several files (e.g. which skill covers the frontend, what the agent must do before a database migration), with no \`sourceFile\`, and the rest about one file in particular. Ask what the instructions mean for working in this project, not how a sentence is worded.

${aimAt(difficulty, INSTRUCTION_DIFFICULTIES)}

${INSTRUCTIONS_FORMAT}${avoid}`

const INSTRUCTION_FILE_PROMPT = (file: string, difficulty: number, avoid: string) => `${INSTRUCTIONS_INTRO} The project is the current directory.

Read ${file}, one of its instruction files for coding agents, and write 2 multiple-choice questions about what it tells the agent to do and when it applies. ${IMPORTS}

${aimAt(difficulty, INSTRUCTION_DIFFICULTIES)}

${INSTRUCTIONS_FORMAT}${avoid}`

// The root files (CLAUDE.md, AGENTS.md), then a random few of the others, in the order found
function sampleInstructionFiles(files: string[]): string[] {
  const rest = files.filter(f => !INSTRUCTION_FILE_NAMES.includes(f))
  const picked = new Set<string>()
  while (picked.size < Math.min(rest.length, INSTRUCTIONS_SAMPLE - (files.length - rest.length))) picked.add(rest[random(rest.length)]!)
  return files.filter(f => !rest.includes(f) || picked.has(f))
}

export function parseQuestions(text: string, difficulty: number, file?: string): Question[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end < start) return []
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw.flatMap((q, i): Question[] => {
    const isValid =
      typeof q?.prompt === 'string' &&
      Array.isArray(q.choices) &&
      q.choices.length === 4 &&
      q.choices.every((c: unknown) => typeof c === 'string') &&
      new Set(q.choices).size === 4 &&
      Number.isInteger(q.answer) &&
      q.answer >= 0 &&
      q.answer < 4
    if (!isValid) return []
    const about = file ?? (typeof q.sourceFile === 'string' && q.sourceFile !== '' ? q.sourceFile : undefined)
    return [
      {
        id: `${about ?? 'repo'}#${Date.now()}-${i}`,
        prompt: q.prompt,
        choices: q.choices,
        answer: q.answer,
        explanation: typeof q.explanation === 'string' ? q.explanation : '',
        sourceFile: about,
        difficulty,
      },
    ]
  })
}

// Before an answer, claude explains without giving it away; after, it explains the answer
const CHAT_PROMPT = (q: Question, chat: Message[], guess: number | null) => `You help a developer with a multiple-choice quiz question ${
  isConcept(q)
    ? `about a general programming concept (${q.topic}). Their project is the current directory: you may relate the concept to it.`
    : categoryOf(q) === 'instructions'
      ? 'about what the project in the current directory tells coding agents, in its instruction files (`CLAUDE.md`, `AGENTS.md`, skills) and the files they import.'
      : 'about the codebase in the current directory.'
} ${
  guess === null ? "They've asked a clarifying question before choosing an answer." : 'They have answered and seen the correct answer, and have a question about it.'
}

The question${q.sourceFile ? ` (about ${q.sourceFile})` : ''}:
${q.prompt}

The choices:
${q.choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}

${
  guess === null
    ? `The correct answer is ${q.answer + 1}. Never reveal it, hint at it, or rule choices in or out: explain what the question means, the terms and concepts it uses${isConcept(q) ? '' : categoryOf(q) === 'instructions' ? ', and the instructions around it' : ', and the surrounding code'}, so they can work it out themselves. You may read the code. If they ask for the answer, say they can pick a choice or skip.`
    : `The correct answer is ${q.answer + 1}.${q.explanation ? ` ${q.explanation}` : ''} They chose ${
        guess === NO_IDEA ? '"Absolutely no idea"' : guess + 1
      }. Help them understand why the answer is right and the others are not. You may read the code.`
}

The discussion so far:
${chat.map(m => `${m.from === 'you' ? 'Developer' : 'You'}: ${m.text}`).join('\n\n')}

If they ask you to change something, you may edit files in the current directory. Issues go in \`${ISSUES_DIR}\`, one markdown file per issue.

Reply to the developer's last message in a few short sentences of plain text. Put identifiers in backticks.`

// The tidbit keys: there's no right answer, so they record a reaction
export const REACTIONS: [Reaction, string][] = [
  ['knew-it', 'Knew it'],
  ['new-to-me', 'New to me'],
  ['not-useful', 'Not useful'],
]

export const THANKS: Record<Reaction, string> = {
  'knew-it': 'Noted: later tidbits will be a bit more advanced.',
  'new-to-me': 'Noted: later tidbits will stay at this level.',
  'not-useful': 'Noted: fewer tidbits on this topic.',
}

const ISSUE_PROMPT = (issue: Issue) => {
  const { about } = issue
  const context =
    about.kind === 'tidbit'
      ? `A developer read a "did you know" tip about coding with LLMs, shown by the Brain Unrot quiz pane, and noticed something that could be improved or fixed (often that the tip is wrong or out of date). Rewrite their note as a short, clear issue for the repository.

The tip:
${about.tidbit.headline}
${about.tidbit.body}
Source: ${about.tidbit.url}`
      : `A developer was answering a multiple-choice quiz question ${
          isConcept(about.question)
            ? `about a general programming concept (${about.question.topic})`
            : categoryOf(about.question) === 'instructions'
              ? "about the project's instructions for coding agents (`CLAUDE.md`, `AGENTS.md`, skills)"
              : 'about the codebase in the current directory'
        } and noticed something that could be improved or fixed. Rewrite their note as a short, clear issue for the repository.

The question${about.question.sourceFile ? ` (about ${about.question.sourceFile})` : ''}:
${about.question.prompt}

The choices:
${about.question.choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}

The correct answer is ${about.question.answer + 1}.${about.question.explanation ? ` ${about.question.explanation}` : ''}`
  return `${context}

Their note:
${issue.text}

You may read the code to name the file, function or variable precisely. Rephrase only what they raised: don't add other problems or fixes of your own. If the ${about.kind === 'tidbit' ? 'tip' : 'quiz question'} itself is wrong or misleading, say so.

If their note asks you to change a file in the repo (say, to update a plan), you may edit files in the current directory to make that change; say in the issue what you changed.

Reply with JSON only, no prose and no code fence:
{"title": "<a short title, under 70 characters>", "body": "<markdown: what the problem is, where it is (file and identifier), and the suggested change if they gave one>"}`
}

export function parseIssue(text: string): { title: string; body: string } | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return undefined
  try {
    const raw = JSON.parse(text.slice(start, end + 1))
    return typeof raw?.title === 'string' && raw.title.trim() !== '' && typeof raw.body === 'string'
      ? { title: raw.title.trim(), body: raw.body.trim() }
      : undefined
  } catch {
    return undefined
  }
}

// The title comes from the model, so keep only safe characters for the file name
export const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '') || 'issue'

// Which store holds a question and its answered list: concept questions are general, the rest belong to the project
type Scope = 'project' | 'global'
const scopeOf = (q: Question): Scope => (isConcept(q) ? 'global' : 'project')
const QUEUE_KEY: Record<Scope, string> = { project: 'queue', global: 'concepts' }
const ANSWERED_KEY: Record<Scope, string> = { project: 'answered', global: 'answered' }

const quizPrefsKey = 'quiz:prefs'
// How often each kind of round comes up, kept across projects. All start at 1
const weightsKey = 'quiz:weights'
const skillKey = 'skill'

// One write to the queues at a time, across every project in this window: the concept queue is shared
let lock: Promise<unknown> = Promise.resolve()

// The weighted topic last written about, kept across projects so a window with several doesn't repeat it
let lastTopic: ConceptTopic | undefined

// Weighted, and never the same topic twice in a row
function pickTopic(): [ConceptTopic, string] {
  const topics = CONCEPT_TOPICS.filter(([t]) => t !== lastTopic)
  let r = random(topics.reduce((sum, [, , weight]) => sum + weight, 0))
  for (const [topic, focus, weight] of topics) {
    r -= weight
    if (r < 0) return [topic, focus]
  }
  const [topic, focus] = topics.at(-1)!
  return [topic, focus]
}

export class Quiz {
  state: QuizState = {
    round: null,
    ready: 0,
    tips: 0,
    skill: { difficulty: DIFFICULTY_MIN, streak: 0 },
    notice: null,
    isAskingPreference: false,
    isClaudeReady: false,
  }

  // Called after every change to `state`, so the panel can redraw
  onChange: () => void = () => undefined

  // Files Claude has read, waiting to be turned into questions
  readonly pending: string[] = []
  private isGenerating = false
  // The file being written about, while it is
  private generatingFile: string | undefined
  // The kinds of question topped up when too few are ready, in the order they take turns, and the one topped up last
  private static readonly TOP_UPS = ['codebase', 'concept', 'instructions'] as const
  private lastTopUp: (typeof Quiz.TOP_UPS)[number] = 'instructions'
  // The project's instruction files, relative to the root, and when they were last looked for
  instructionFiles: string[] = []
  private instructionsCheckedAt = -Infinity
  private retryAt = 0
  // The file you asked for more questions about: its questions come first, ahead of concept
  // questions and tidbits, until none are left or being written
  private moreAboutFile: string | undefined
  // Files you asked for more about from an instruction question. A file imported by CLAUDE.md
  // (say docs/testing.md) isn't named like an instruction file, so it's known from this
  private readonly instructionSources = new Set<string>()
  // A clarifying question waiting for a reply; the reply lands only if the round is still the same
  private isChatting = false
  // Issues you've described, waiting to be rephrased and written; they outlive the round
  private readonly issues: Issue[] = []
  private isFiling = false
  // Claude finished its turn: when the round you're on ends, the panel says so in place of the next one
  isClaudeFinished = false

  constructor(readonly host: Host) {}

  private debug(line: string) {
    this.host.log(line)
  }

  private store(scope: Scope): Store {
    return scope === 'project' ? this.host.project : this.host.global
  }

  async update(change: Partial<QuizState> | ((s: QuizState) => Partial<QuizState>)) {
    this.state = { ...this.state, ...(typeof change === 'function' ? change(this.state) : change) }
    this.onChange()
  }

  private updateRound(fn: (r: Round | null) => Round | null) {
    return this.update(s => ({ round: fn(s.round) }))
  }

  // Loads what the panel shows at first; generation and research run on the timers
  async start() {
    await this.update({ ready: (await this.loadQueue()).length, skill: await this.loadSkill() })
    await this.countTips()
  }

  // --- The queue ---

  private async loadScope(scope: Scope): Promise<Question[]> {
    const stored = await this.store(scope).get(QUEUE_KEY[scope])
    return Array.isArray(stored) ? (stored as Question[]) : []
  }

  // Both queues as one, newest first within each. Concept questions written for another project count too
  async loadQueue(): Promise<Question[]> {
    return [...(await this.loadScope('project')), ...(await this.loadScope('global'))]
  }

  private async saveQueue(queue: Question[]) {
    for (const scope of ['project', 'global'] as const) {
      await this.store(scope).set(QUEUE_KEY[scope], queue.filter(q => scopeOf(q) === scope).slice(0, QUEUE_MAX))
    }
    await this.update({ ready: Math.min(queue.length, 2 * QUEUE_MAX) })
  }

  // One queue write at a time: the generator and the panel both take from it
  private withQueue<T>(fn: (queue: Question[]) => Promise<[Question[], T]>): Promise<T> {
    const run = lock.then(async () => {
      const [next, result] = await fn(await this.loadQueue())
      await this.saveQueue(next)
      return result
    })
    lock = run.catch(() => undefined)
    return run
  }

  // Prompts answered right or skipped, so they aren't asked again. Generated ids change each time,
  // so a question is known by its prompt. Codebase and instruction prompts are kept per project,
  // concept prompts (and seed questions, which are general) globally
  private async loadAnsweredIn(scope: Scope): Promise<string[]> {
    const stored = await this.store(scope).get(ANSWERED_KEY[scope])
    return Array.isArray(stored) ? (stored as string[]) : []
  }

  private async loadAnswered(): Promise<string[]> {
    return [...(await this.loadAnsweredIn('project')), ...(await this.loadAnsweredIn('global'))]
  }

  private async remember(q: Question) {
    const scope = SEEDS.some(seed => seed.id === q.id) ? 'global' : scopeOf(q)
    const answered = (await this.loadAnsweredIn(scope)).filter(p => said(p) !== said(q.prompt))
    await this.store(scope).set(ANSWERED_KEY[scope], [...answered, q.prompt].slice(-ANSWERED_MAX))
  }

  // A question answered wrong goes to the back of its queue, to come round again later.
  // Seed questions stay out of it: they're picked from SEEDS again anyway
  private async requeue(q: Question) {
    if (SEEDS.some(seed => seed.id === q.id)) return
    await this.withQueue(async queue => {
      const rest = queue.filter(p => p.id !== q.id)
      const same = rest.filter(p => scopeOf(p) === scopeOf(q)).slice(0, QUEUE_MAX - 1)
      return [[...rest.filter(p => scopeOf(p) !== scopeOf(q)), ...same, q], undefined]
    })
  }

  // --- Preferences ---

  private async loadQuizPrefs(): Promise<QuizPrefs> {
    const stored = (await this.host.global.get(quizPrefsKey)) as Partial<QuizPrefs> | undefined
    return { offerChance: stored?.offerChance ?? OFFER_CHANCE, preferenceChance: stored?.preferenceChance ?? PREFERENCE_CHANCE }
  }

  async loadWeights(): Promise<CategoryWeights> {
    const stored = (await this.host.global.get(weightsKey)) as Partial<CategoryWeights> | undefined
    return { codebase: 1, concept: 1, instructions: 1, tidbit: 1, ...stored }
  }

  private async prefer(category: Category) {
    const weights = await this.loadWeights()
    const next = { ...weights, [category]: weights[category] + 1 }
    await this.host.global.set(weightsKey, next)
    this.debug(`prefer ${category}: ${CATEGORIES.map(([c]) => next[c]).join(':')}`)
  }

  // Yes: the file's questions go to the front, and more are written if too few fit your difficulty.
  // The question just shown stays where it is, so it doesn't come straight back
  private async wantMore(shown: Question, file: string) {
    const s = await this.loadSkill()
    const known = new Set((await this.loadAnswered()).map(said))
    const root = this.host.root
    const fitting = await this.withQueue(async queue => {
      const about = queue.filter(q => q.sourceFile === file && q.id !== shown.id)
      const rest = queue.filter(q => !about.includes(q))
      return [[...about, ...rest], about.filter(q => fits(q, s) && !known.has(said(q.prompt))).length]
    })
    this.moreAboutFile = file
    if (categoryOf(shown) === 'instructions') this.instructionSources.add(file)
    if (fitting < MORE_ABOUT_FILE_LOW) {
      const waiting = this.pending.findIndex(p => sameFile(root, p, file))
      if (waiting >= 0) this.pending.splice(waiting, 1)
      this.pending.unshift(file)
    }
    this.debug(`more about ${file}: yes, ${fitting} ready${fitting < MORE_ABOUT_FILE_LOW ? ', writing more' : ''}`)
  }

  // No: the file's questions go to the back, and none are written for it now. The back is also
  // where the queue is trimmed when it's full, so they're the first to go
  private async wantNoMore(file: string) {
    if (this.moreAboutFile === file) this.moreAboutFile = undefined
    const waiting = this.pending.findIndex(p => sameFile(this.host.root, p, file))
    if (waiting >= 0) this.pending.splice(waiting, 1)
    await this.withQueue(async queue => {
      const about = queue.filter(q => q.sourceFile === file)
      return [[...queue.filter(q => !about.includes(q)), ...about], undefined]
    })
    this.debug(`more about ${file}: no`)
  }

  // --- Skill: a 3-up staircase per project; a wrong answer or "no idea" steps down ---

  async loadSkill(): Promise<Skill> {
    const stored = (await this.host.project.get(skillKey)) as Partial<Skill> | undefined
    return typeof stored?.difficulty === 'number' ? { difficulty: stored.difficulty, streak: stored.streak ?? 0 } : { difficulty: DIFFICULTY_MIN, streak: 0 }
  }

  private async record(outcome: Outcome) {
    const next = stepped(await this.loadSkill(), outcome)
    await this.host.project.set(skillKey, next)
    await this.update({ skill: next })
    this.debug(`skill: ${outcome} -> difficulty ${next.difficulty}, streak ${next.streak}`)
  }

  // --- Rounds ---

  // Seed questions not yet answered right, other than `last`
  private async seedsLeft(last?: string): Promise<Question[]> {
    const known = new Set((await this.loadAnswered()).map(said))
    return SEEDS.filter(q => !known.has(said(q.prompt)) && q.id !== last)
  }

  private async nextSeed(last?: string): Promise<Question | undefined> {
    const seeds = await this.seedsLeft(last)
    const seed = seeds[random(seeds.length)]
    return seed && shuffle(seed)
  }

  // The newest generated question of the category at or below your difficulty; questions above it wait,
  // and questions already answered right are dropped. A file you asked for more about comes first.
  // `last` is the question just shown: it isn't asked again straight away while a seed question is left
  private async nextQuestion(category: Exclude<Category, 'tidbit'>, last?: string): Promise<Question | undefined> {
    const s = await this.loadSkill()
    const known = new Set((await this.loadAnswered()).map(said))
    const isSeedLeft = (await this.seedsLeft(last)).length > 0
    const moreAboutFile = this.moreAboutFile
    const taken = await this.withQueue(async all => {
      const queue = all.filter(q => !known.has(said(q.prompt)))
      const canTake = (q: Question) => fits(q, s) && categoryOf(q) === category && (q.id !== last || !isSeedLeft)
      const aboutFile = moreAboutFile === undefined ? -1 : queue.findIndex(q => canTake(q) && q.id !== last && q.sourceFile === moreAboutFile)
      const i = aboutFile >= 0 ? aboutFile : queue.findIndex(canTake)
      return i < 0 ? [queue, undefined] : [queue.filter((_, j) => j !== i), queue[i]]
    })
    return taken && shuffle(taken)
  }

  async countTips() {
    await this.update({ tips: await tidbitsReady(this.host) })
  }

  // The category of a ready question about the file you asked for more about, if it has one
  // (a codebase or an instruction file); once it has none ready or on the way, it's forgotten
  private async moreAboutFileReady(): Promise<Exclude<Category, 'tidbit'> | undefined> {
    const file = this.moreAboutFile
    if (file === undefined) return undefined
    const root = this.host.root
    const s = await this.loadSkill()
    const known = new Set((await this.loadAnswered()).map(said))
    const ready = (await this.loadQueue()).find(q => q.sourceFile === file && fits(q, s) && !known.has(said(q.prompt)))
    const isComing = [...this.pending, ...(this.generatingFile ? [this.generatingFile] : [])].some(p => sameFile(root, p, file))
    if (!ready && !isComing) this.moreAboutFile = undefined
    return ready && categoryOf(ready)
  }

  // The categories are tried in an order picked by weight (see weightedOrder), until one has something
  // ready; codebase questions fall back to a seed question, as does having nothing ready in any.
  // While a file you asked for more about has questions ready, they come first.
  // Nothing changes while the panel asks which kind you'd like more of, so no round is taken unseen
  async newRound() {
    if (this.state.isAskingPreference) return
    const last = this.state.round
    const lastQuestion = last && last.kind !== 'tidbit' ? last.question.id : undefined
    const order = weightedOrder(await this.loadWeights())
    const first = await this.moreAboutFileReady()
    const tried: Category[] = first ? [first, ...order.filter(c => c !== first)] : order
    this.debug(`round: trying ${tried.join(', ')}`)
    for (const category of tried) {
      if (category === 'tidbit') {
        const tidbit = await nextTidbit(this.host)
        if (!tidbit) continue
        this.debug(`round: tidbit ${tidbit.id}`)
        await this.update({ round: { kind: 'tidbit', tidbit, reaction: null } })
        await this.countTips()
        return
      }
      const question = (await this.nextQuestion(category, lastQuestion)) ?? (category === 'codebase' ? await this.nextSeed(lastQuestion) : undefined)
      if (!question) continue
      this.debug(`round: ${question.id} ${question.sourceFile ?? (SEEDS.some(seed => seed.id === question.id) ? '(seed)' : '')}`)
      await this.update({ round: { kind: 'question', question, guess: null } })
      return
    }
    const seed = await this.nextSeed(lastQuestion)
    this.debug(`round: ${seed ? `${seed.id} (seed)` : '(none left)'}`)
    await this.update({ round: seed ? { kind: 'question', question: seed, guess: null } : null })
  }

  // The round you're on has ended. Once Claude has finished its turn, the panel says so instead of
  // starting the next round; "Keep going" starts it
  private async endRound() {
    if (this.isClaudeFinished) {
      this.debug('round ended after Claude finished: showing "Claude is ready"')
      await this.update({ isClaudeReady: true })
      return
    }
    await this.newRound()
  }

  // Moving on sometimes asks something first: whether you'd like more questions about the file
  // the question was about, or else which kind of round you'd like more of.
  // `question` is absent when moving on from a tidbit
  private async moveOn(question?: Question) {
    if (this.isClaudeFinished) return this.endRound()
    const { offerChance, preferenceChance } = await this.loadQuizPrefs()
    if (question?.sourceFile && random(1000) < offerChance * 1000) {
      this.debug(`offer: more about ${question.sourceFile}`)
      await this.updateRound(r => (r?.kind === 'question' ? { ...r, isOffering: true, chat: undefined, issue: undefined } : r))
      return
    }
    if (random(1000) < preferenceChance * 1000) {
      this.debug('asking which kind of round you would like more of')
      await this.update({ isAskingPreference: true })
      return
    }
    await this.newRound()
  }

  // --- Events from Claude ---

  // A prompt was sent: a new round, and Claude is busy again
  async onPrompt() {
    this.isClaudeFinished = false
    await this.update({ isClaudeReady: false })
    await this.newRound()
  }

  // Claude finished its turn. Nothing interrupts the round you're on
  async onStop() {
    this.isClaudeFinished = true
    this.onChange()
  }

  // Claude read a file: questions get written about it
  onRead(file: string) {
    if (this.pending.includes(file)) return
    this.pending.push(file)
    this.debug(`queued ${file}`)
  }

  // --- Actions from the panel ---

  async act(action: Action) {
    const current = this.state.round
    switch (action.type) {
      case 'next':
        if (current === null) return this.newRound()
        return this.moveOn(current.kind === 'question' ? current.question : undefined)
      case 'keepGoing':
        this.isClaudeFinished = false
        await this.update({ isClaudeReady: false })
        return this.newRound()
      case 'prefer':
        if (action.category) await this.prefer(action.category)
        await this.update({ isAskingPreference: false })
        return this.endRound()
      case 'cancelIssue':
        return this.updateRound(r => (r ? { ...r, issue: undefined } : r))
    }
    if (!current) return
    const id = current.kind === 'tidbit' ? current.tidbit.id : current.question.id
    switch (action.type) {
      case 'ask':
        this.debug(`chat ${id}: opened`)
        await this.updateRound(r => (r ? { ...r, chat: [] } : r))
        // Asking about a tidbit turns its topic up
        if (current.kind === 'tidbit') await react(this.host, current.tidbit, 'asked')
        return
      case 'send': {
        const text = action.text.trim()
        if (text === '') return
        // The chat timer picks this up and asks claude
        const message: Message = { from: 'you', text }
        return this.updateRound(r => (r?.chat && !r.isThinking ? { ...r, chat: [...r.chat, message], isThinking: true } : r))
      }
      // The issue box sits on top of the round; closing it leaves the round as it was
      case 'report':
        this.debug(`issue ${id}: opened`)
        return this.updateRound(r => (r ? { ...r, issue: true } : r))
      case 'submitIssue': {
        const text = action.text.trim()
        if (text === '') return
        // The issue timer picks this up, asks claude to rephrase it and writes the file
        const about: Issue['about'] = current.kind === 'tidbit' ? { kind: 'tidbit', tidbit: current.tidbit } : { kind: 'question', question: current.question }
        this.issues.push({ text, about })
        await this.update({ notice: 'Filing the issue…' })
        return this.updateRound(r => (r ? { ...r, issue: undefined } : r))
      }
      case 'react': {
        if (current.kind !== 'tidbit') return
        this.debug(`tidbit ${id}: ${action.reaction}`)
        await this.updateRound(r => (r?.kind === 'tidbit' ? { ...r, reaction: action.reaction } : r))
        return react(this.host, current.tidbit, action.reaction)
      }
    }
    if (current.kind !== 'question') return
    const { question } = current
    switch (action.type) {
      case 'choose': {
        if (current.guess !== null) return
        const i = action.index
        this.debug(`guess: ${i} (answer ${question.answer})`)
        await this.updateRound(r => (r?.kind === 'question' ? { ...r, guess: i } : r))
        const isRight = i === question.answer
        const wasHelped = current.chat?.some(m => m.from === 'you') ?? false
        await this.record(i === NO_IDEA ? 'no-idea' : isRight && wasHelped ? 'helped' : isRight ? 'right' : 'wrong')
        return isRight ? this.remember(question) : this.requeue(question)
      }
      // A skipped question isn't asked again, and doesn't move the difficulty
      case 'skip':
        this.debug(`skip: ${question.id}`)
        await this.remember(question)
        return this.moveOn(question)
      case 'moreAboutFile': {
        const file = question.sourceFile
        if (!current.isOffering || !file) return
        await (action.isYes ? this.wantMore(question, file) : this.wantNoMore(file))
        return this.endRound()
      }
    }
  }

  // --- What the panel shows, beyond the state ---

  async view() {
    const round = this.state.round
    const weights = await this.loadWeights()
    // Instruction questions are only offered in a project that has instruction files
    const hasInstructions = this.instructionFiles.length > 0 || (await this.loadQueue()).some(q => categoryOf(q) === 'instructions')
    const categories = CATEGORIES.filter(([category]) => category !== 'instructions' || hasInstructions)
    return {
      ...this.state,
      root: this.host.root,
      difficultyMax: DIFFICULTY_MAX,
      issuesDir: ISSUES_DIR,
      isClaudeFinished: this.isClaudeFinished,
      preference: this.state.isAskingPreference ? { categories: categories.map(([category, label]) => ({ category, label, weight: weights[category] })) } : undefined,
      tidbitSource: round?.kind === 'tidbit' ? sourceLine(round.tidbit, this.host.now(), await installedVersion(this.host)) : undefined,
    }
  }

  // --- Background work, run on timers ---

  async discuss() {
    if (this.isChatting) return
    const current = this.state.round
    const chat = current?.chat
    if (!current || !chat || chat.at(-1)?.from !== 'you') return

    this.isChatting = true
    const roundId = (r: Round) => (r.kind === 'tidbit' ? r.tidbit.id : r.question.id)
    const id = roundId(current)
    const guess = current.kind === 'tidbit' ? undefined : current.guess
    const same = (r: Round | null): r is Round => r !== null && roundId(r) === id && (r.kind === 'tidbit' || r.guess === guess) && r.chat !== undefined
    const reply = (text: string) => this.updateRound(r => (same(r) ? { ...r, chat: [...chat, { from: 'claude', text } as Message], isThinking: false } : r))
    try {
      this.debug(`chat ${id}: asking claude`)
      const root = this.host.root
      const text =
        current.kind === 'tidbit'
          ? await askAboutTidbit(this.host, current.tidbit, chat, root)
          : (await askClaude(this.host, CHAT_PROMPT(current.question, chat, current.guess), { ...EDIT, cwd: root })).text
      await reply(text.trim() || '(no reply)')
    } catch (err) {
      this.debug(`chat ${id}: ${String(err)}`)
      await reply('Sorry, that failed. Try asking again.')
    } finally {
      this.isChatting = false
    }
  }

  private async freePath(dir: string, name: string): Promise<string> {
    for (let n = 1; ; n++) {
      const path = `${dir}/${name}${n === 1 ? '' : `-${n}`}.md`
      if (!(await this.host.fs.exists(path))) return path
    }
  }

  async fileIssue() {
    if (this.isFiling) return
    const issue = this.issues.shift()
    if (!issue) return

    this.isFiling = true
    const { about } = issue
    const id = about.kind === 'tidbit' ? about.tidbit.id : about.question.id
    const root = this.host.root
    try {
      let rephrased: { title: string; body: string } | undefined
      try {
        this.debug(`issue ${id}: asking claude`)
        rephrased = parseIssue((await askClaude(this.host, ISSUE_PROMPT(issue), { ...EDIT, cwd: root })).text)
        if (!rephrased) this.debug(`issue ${id}: unparsed reply`)
      } catch (err) {
        this.debug(`issue ${id}: ${String(err)}`)
      }
      // Never lose what you typed: without a rephrasing, file it as written
      const title = rephrased?.title ?? issue.text.split('\n')[0]!.slice(0, 70)
      const date = new Date(this.host.now()).toISOString().slice(0, 10)
      const path = await this.freePath(`${root}/${ISSUES_DIR}`, `${date}-${slug(title)}`)
      const text = [
        `# ${title}`,
        '',
        rephrased?.body ?? issue.text,
        '',
        '## Context',
        '',
        ...(about.kind === 'tidbit'
          ? [`Raised on a Brain Unrot "did you know" tip from ${about.tidbit.url}:`, '', `> ${about.tidbit.headline}`]
          : [
              `Raised while answering a Brain Unrot quiz question${
                about.question.sourceFile
                  ? ` about \`${about.question.sourceFile}\``
                  : about.question.topic
                    ? ` about ${about.question.topic}`
                    : categoryOf(about.question) === 'instructions'
                      ? " about the project's instructions for coding agents"
                      : ''
              }:`,
              '',
              `> ${about.question.prompt}`,
            ]),
        '',
        'Original note:',
        '',
        ...issue.text.split('\n').map(line => `> ${line}`),
        '',
      ].join('\n')
      await this.host.fs.write(path, text)
      const shown = path.slice(root.length + 1)
      this.debug(`issue ${id}: wrote ${shown}`)
      await this.update({ notice: `Filed ${shown}` })
    } catch (err) {
      this.debug(`issue ${id}: ${String(err)}`)
      await this.update({ notice: 'Filing the issue failed; see the Brain Unrot output' })
    } finally {
      this.isFiling = false
    }
  }

  // The project's instruction files, relative to the root. A skill linked from .claude/skills to
  // .agents/skills is one file, so it's listed once
  private async findInstructionFiles(): Promise<string[]> {
    const root = this.host.root
    const exists = (path: string) => this.host.fs.exists(`${root}/${path}`).catch(() => false)
    const list = (dir: string) => this.host.fs.list(`${root}/${dir}`).catch(() => [])
    const candidates: string[] = [...INSTRUCTION_FILE_NAMES]
    for (const dir of SKILL_DIRS) candidates.push(...(await list(dir)).filter(e => e.kind !== 'file').map(e => `${dir}/${e.name}/SKILL.md`))
    for (const dir of AGENT_DIRS) candidates.push(...(await list(dir)).filter(e => e.name.endsWith('.md')).map(e => `${dir}/${e.name}`))
    const found: string[] = []
    const seen = new Set<string>()
    for (const path of candidates) {
      if (!(await exists(path))) continue
      const real = await this.host.fs.realPath(`${root}/${path}`).catch(() => path)
      if (seen.has(real)) continue
      seen.add(real)
      found.push(path)
    }
    return found
  }

  async generate() {
    const host = this.host
    if (this.isGenerating || host.now() < this.retryAt) return
    const queue = await this.loadQueue()
    const s = await this.loadSkill()
    // A file Claude read comes first; otherwise top up whichever kind has too few at or below
    // your difficulty, taking turns when several do. Instruction questions need instruction files
    const file = this.pending.shift()
    const fitting = queue.filter(q => fits(q, s))
    const count = (category: Category) => fitting.filter(q => categoryOf(q) === category).length
    const root = host.root
    const now = host.now()
    if (file === undefined && count('instructions') < INSTRUCTIONS_LOW && now - this.instructionsCheckedAt >= INSTRUCTIONS_RECHECK_MS) {
      this.instructionsCheckedAt = now
      this.instructionFiles = await this.findInstructionFiles()
      this.debug(`instruction files: ${this.instructionFiles.join(', ') || '(none)'}`)
    }
    const isLow = {
      codebase: count('codebase') < QUEUE_LOW,
      concept: count('concept') < CONCEPTS_LOW,
      instructions: this.instructionFiles.length > 0 && count('instructions') < INSTRUCTIONS_LOW,
    }
    const turn = [...Quiz.TOP_UPS.slice(Quiz.TOP_UPS.indexOf(this.lastTopUp) + 1), ...Quiz.TOP_UPS].find(c => isLow[c])
    if (file === undefined && turn === undefined) return
    const shown = file?.startsWith(root + '/') ? file.slice(root.length + 1) : file
    const kind = shown === undefined ? turn! : isInstructionFile(shown) || this.instructionSources.has(shown) ? 'instructions' : 'codebase'
    const difficulty = difficultyOf(s)
    // Concept questions avoid concept questions; the rest avoid this project's questions
    const scope: Scope = kind === 'concept' ? 'global' : 'project'
    const answered = await this.loadAnsweredIn(scope)

    this.isGenerating = true
    this.generatingFile = file
    const [topic, focus] = kind === 'concept' ? pickTopic() : []
    const label = topic ? `concept ${topic}` : kind === 'instructions' ? `instructions ${shown ?? '(all)'}` : (shown ?? 'repo')
    try {
      this.debug(`generate ${label} at difficulty ${difficulty}: asking claude`)
      const avoid = avoiding(
        queue.filter(q => scopeOf(q) === scope),
        answered,
      )
      if (file === undefined) this.lastTopUp = kind
      if (topic) lastTopic = topic
      const prompt =
        focus !== undefined
          ? CONCEPT_PROMPT(focus, difficulty, avoid)
          : kind === 'instructions'
            ? shown
              ? INSTRUCTION_FILE_PROMPT(shown, difficulty, avoid)
              : INSTRUCTIONS_PROMPT(sampleInstructionFiles(this.instructionFiles), difficulty, avoid)
            : shown
              ? FILE_PROMPT(shown, difficulty, avoid)
              : REPO_PROMPT(difficulty, avoid)
      const { text: reply } = await askClaude(host, prompt, { ...(topic ? CONCEPT : kind === 'instructions' ? INSTRUCTIONS : CODE), cwd: root })
      // The avoid list is only a request, so drop any repeat of a question answered right
      const known = new Set(answered.map(said))
      const parsed = parseQuestions(reply, difficulty, shown)
      const questions = (
        topic
          ? parsed.map((q, i): Question => ({ ...q, id: `concept:${topic}#${Date.now()}-${i}`, sourceFile: undefined, category: 'concept', topic, project: root }))
          : kind === 'instructions'
            ? parsed.map((q, i): Question => ({ ...q, id: `instructions:${q.sourceFile ?? 'all'}#${Date.now()}-${i}`, category: 'instructions' }))
            : parsed
      ).filter(q => !known.has(said(q.prompt)))
      this.debug(`generate ${label}: ${questions.length} questions`)
      if (questions.length > 0) {
        await this.withQueue(async current => [[...questions, ...current], undefined])
      } else {
        this.debug(`generate ${label}: unparsed reply ${JSON.stringify(reply.slice(0, 300))}`)
        // Leave instruction questions be until the files are looked for again, rather than ask every tick
        if (kind === 'instructions' && !shown) {
          this.instructionFiles = []
          this.instructionsCheckedAt = host.now()
        }
      }
    } catch (err) {
      this.debug(`generate ${label}: ${String(err)}`)
      this.retryAt = host.now() + RETRY_MS
    } finally {
      this.isGenerating = false
      this.generatingFile = undefined
    }
  }

  // Tidbit research runs about once a day, apart from question generation
  async research() {
    if ((await refresh(this.host)).length > 0) await this.countTips()
  }
}
