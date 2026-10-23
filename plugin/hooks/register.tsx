import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Category, CategoryWeights, ConceptTopic, Issue, Message, Question, QuizPrefs, Reaction, Round, Skill, Tidbit } from '../types'
import { askClaude, debug, random } from './claude'
import { SEEDS } from './seeds'
import { askAboutTidbit, installedVersion, nextTidbit, react, refresh, sourceLine, tidbitsReady } from './tidbits'

const PANE = 'brain-unrot'
const MODEL = 'haiku'
const QUEUE_MAX = 30
// Prompts answered right or skipped that are remembered, and how many of them generation is told to avoid
const ANSWERED_MAX = 200
const AVOID_MAX = 50
// Below this many ready questions, generate some about the repo as a whole
const QUEUE_LOW = 5
const TICK_MS = 3000
// How often to check for a clarifying question waiting for a reply, or an issue to file
const CHAT_TICK_MS = 1000
const ISSUES_DIR = 'docs/issues/todo'
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
const NO_IDEA = -1
const DIFFICULTY_MIN = 1
const DIFFICULTY_MAX = 5
// Right answers in a row that move the difficulty up one
const STREAK_UP = 3
// How often moving on from a question about a file asks whether you'd like more about it.
// Saying yes generates more when fewer than this many are ready at your difficulty
const OFFER_CHANCE = 0.5
const MORE_ABOUT_FILE_LOW = 2
// How often moving on asks which kind of round you'd like more of
const PREFERENCE_CHANCE = 0.1

const CATEGORIES: [Category, string][] = [
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

const round = atom({ plugin: 'brain-unrot', key: 'round' } as const, null as Round | null)
const ready = atom({ plugin: 'brain-unrot', key: 'ready' } as const, 0)
// Tidbits ready to show, not counting the seed tidbits
const tips = atom({ plugin: 'brain-unrot', key: 'tips' } as const, 0)
const skill = atom({ plugin: 'brain-unrot', key: 'skill' } as const, { difficulty: DIFFICULTY_MIN, streak: 0 } as Skill)
// A line in the footer about the last issue filed, e.g. where it was written
const notice = atom({ plugin: 'brain-unrot', key: 'notice' } as const, null as string | null)
// Set while the pane asks which kind of round you'd like more of; the round waits underneath
const isAskingPreference = atom({ plugin: 'brain-unrot', key: 'isAskingPreference' } as const, false)

// Models (and the seeds) put the right answer first far too often
function shuffle(q: Question): Question {
  const order = q.choices.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    const j = random(i + 1)
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  return { ...q, choices: order.map(i => q.choices[i]!), answer: order.indexOf(q.answer) }
}

// The question queue: generated questions kept in $.store per project, newest first
const queueKey = async ($: EngineInterface) => `queue:${await $.session.root()}`

// Before the renames: the queue was stored as `pantry:<root>`, difficulty as `level` and sourceFile as `file`
type Legacy = { level?: number; file?: string }
const legacyKey = async ($: EngineInterface) => `pantry:${await $.session.root()}`

async function loadQueue($: EngineInterface): Promise<Question[]> {
  const stored = (await $.store.get(await queueKey($))) ?? (await $.store.get(await legacyKey($)))
  if (!Array.isArray(stored)) return []
  return (stored as (Question & Legacy)[]).map(({ level, file, ...q }) => ({
    ...q,
    ...(q.difficulty === undefined && level !== undefined ? { difficulty: level } : {}),
    ...(q.sourceFile === undefined && file !== undefined ? { sourceFile: file } : {}),
  }))
}

async function saveQueue($: EngineInterface, queue: Question[]) {
  await $.store.set(await queueKey($), queue.slice(0, QUEUE_MAX))
  await update($, ready, () => Math.min(queue.length, QUEUE_MAX))
}

// One queue write at a time: the generator and the pane both take from it
let lock: Promise<unknown> = Promise.resolve()
function withQueue<T>($: EngineInterface, fn: (queue: Question[]) => Promise<[Question[], T]>): Promise<T> {
  const run = lock.then(async () => {
    const [next, result] = await fn(await loadQueue($))
    await saveQueue($, next)
    return result
  })
  lock = run.catch(() => undefined)
  return run
}

// Prompts answered right or skipped, kept per project so they aren't asked again. Generated ids
// change each time, so a question is known by its prompt
const answeredKey = async ($: EngineInterface) => `answered:${await $.session.root()}`
const said = (prompt: string) => prompt.trim().toLowerCase().replace(/\s+/g, ' ')

async function loadAnswered($: EngineInterface): Promise<string[]> {
  const stored = await $.store.get(await answeredKey($))
  return Array.isArray(stored) ? (stored as string[]) : []
}

async function remember($: EngineInterface, q: Question) {
  const answered = (await loadAnswered($)).filter(p => said(p) !== said(q.prompt))
  await $.store.set(await answeredKey($), [...answered, q.prompt].slice(-ANSWERED_MAX))
}

// A question answered wrong goes to the back of the queue, to come round again later.
// Seed questions stay out of it: they're picked from SEEDS again anyway
async function requeue($: EngineInterface, q: Question) {
  if (SEEDS.some(seed => seed.id === q.id)) return
  await withQueue($, async queue => [[...queue.filter(p => p.id !== q.id).slice(0, QUEUE_MAX - 1), q], undefined])
}

// The file you asked for more questions about: its questions come first, ahead of concept
// questions and tidbits, until none are left or being written
let moreAboutFile: string | undefined
// Files you asked for more about from an instruction question. A file imported by CLAUDE.md
// (say docs/testing.md) isn't named like an instruction file, so it's known from this
const instructionSources = new Set<string>()

const quizPrefsKey = 'quiz:prefs'

async function loadQuizPrefs($: EngineInterface): Promise<QuizPrefs> {
  const stored = (await $.store.get(quizPrefsKey)) as Partial<QuizPrefs> | undefined
  return { offerChance: stored?.offerChance ?? OFFER_CHANCE, preferenceChance: stored?.preferenceChance ?? PREFERENCE_CHANCE }
}

// How often each kind of round comes up, kept across projects. All start at 1
const weightsKey = 'quiz:weights'

async function loadWeights($: EngineInterface): Promise<CategoryWeights> {
  const stored = (await $.store.get(weightsKey)) as Partial<CategoryWeights> | undefined
  return { codebase: 1, concept: 1, instructions: 1, tidbit: 1, ...stored }
}

async function prefer($: EngineInterface, category: Category) {
  const weights = await loadWeights($)
  const next = { ...weights, [category]: weights[category] + 1 }
  await $.store.set(weightsKey, next)
  debug($, `prefer ${category}: ${CATEGORIES.map(([c]) => next[c]).join(':')}`)
}

// The categories in a random order, each picked in turn by weight from those left.
// A category weighted 0 is left out
function weightedOrder(weights: CategoryWeights): Category[] {
  const left = CATEGORIES.map(([c]) => c).filter(c => weights[c] > 0)
  const order: Category[] = []
  while (left.length > 0) {
    let r = random(left.reduce((sum, c) => sum + weights[c], 0))
    const i = left.findIndex(c => (r -= weights[c]) < 0)
    order.push(...left.splice(i < 0 ? left.length - 1 : i, 1))
  }
  return order
}

// The same file, whether it's the absolute path the Read hook saw or a question's relative sourceFile
const sameFile = (root: string, a: string, b: string) => {
  const relative = (path: string) => (path.startsWith(root + '/') ? path.slice(root.length + 1) : path)
  return relative(a) === relative(b)
}

// Yes: the file's questions go to the front, and more are written if too few fit your difficulty.
// The question just shown stays where it is, so it doesn't come straight back
async function wantMore($: EngineInterface, shown: Question, file: string) {
  const s = await loadSkill($)
  const known = new Set((await loadAnswered($)).map(said))
  const root = await $.session.root()
  const fitting = await withQueue($, async queue => {
    const about = queue.filter(q => q.sourceFile === file && q.id !== shown.id)
    const rest = queue.filter(q => !about.includes(q))
    return [[...about, ...rest], about.filter(q => fits(q, s) && !known.has(said(q.prompt))).length]
  })
  moreAboutFile = file
  if (categoryOf(shown) === 'instructions') instructionSources.add(file)
  if (fitting < MORE_ABOUT_FILE_LOW) {
    const waiting = pending.findIndex(p => sameFile(root, p, file))
    if (waiting >= 0) pending.splice(waiting, 1)
    pending.unshift(file)
  }
  debug($, `more about ${file}: yes, ${fitting} ready${fitting < MORE_ABOUT_FILE_LOW ? ', writing more' : ''}`)
}

// No: the file's questions go to the back, and none are written for it now. The back is also
// where the queue is trimmed when it's full, so they're the first to go
async function wantNoMore($: EngineInterface, file: string) {
  if (moreAboutFile === file) moreAboutFile = undefined
  const root = await $.session.root()
  const waiting = pending.findIndex(p => sameFile(root, p, file))
  if (waiting >= 0) pending.splice(waiting, 1)
  await withQueue($, async queue => {
    const about = queue.filter(q => q.sourceFile === file)
    return [[...queue.filter(q => !about.includes(q)), ...about], undefined]
  })
  debug($, `more about ${file}: no`)
}

// Skill: a 3-up staircase per project; a wrong answer or "no idea" steps down
const skillKey = async ($: EngineInterface) => `skill:${await $.session.root()}`

const difficultyOf = (s: Skill) => Math.floor(s.difficulty)
const fits = (q: Question, s: Skill) => (q.difficulty ?? DIFFICULTY_MIN) <= difficultyOf(s)
const isConcept = (q: Question) => q.category === 'concept'
const categoryOf = (q: Question) => q.category ?? 'codebase'

async function loadSkill($: EngineInterface): Promise<Skill> {
  const stored = (await $.store.get(await skillKey($))) as (Partial<Skill> & Legacy) | undefined
  const difficulty = stored?.difficulty ?? stored?.level
  return typeof difficulty === 'number' ? { difficulty, streak: stored?.streak ?? 0 } : { difficulty: DIFFICULTY_MIN, streak: 0 }
}

// `helped` is a right answer after a clarifying discussion: it doesn't move the difficulty
type Outcome = 'right' | 'wrong' | 'no-idea' | 'helped'

function stepped(s: Skill, outcome: Outcome): Skill {
  const clamp = (n: number) => Math.min(DIFFICULTY_MAX, Math.max(DIFFICULTY_MIN, n))
  if (outcome === 'no-idea') return { difficulty: clamp(s.difficulty - 1), streak: 0 }
  if (outcome === 'wrong') return { difficulty: clamp(s.difficulty - 0.5), streak: 0 }
  if (outcome === 'helped') return s
  return s.streak + 1 >= STREAK_UP ? { difficulty: clamp(s.difficulty + 1), streak: 0 } : { ...s, streak: s.streak + 1 }
}

async function record($: EngineInterface, outcome: Outcome) {
  const next = stepped(await loadSkill($), outcome)
  await $.store.set(await skillKey($), next)
  await update($, skill, () => next)
  debug($, `skill: ${outcome} -> difficulty ${next.difficulty}, streak ${next.streak}`)
}

// Seed questions not yet answered right, other than `last`
async function seedsLeft($: EngineInterface, last?: string): Promise<Question[]> {
  const known = new Set((await loadAnswered($)).map(said))
  return SEEDS.filter(q => !known.has(said(q.prompt)) && q.id !== last)
}

async function nextSeed($: EngineInterface, last?: string): Promise<Question | undefined> {
  const seeds = await seedsLeft($, last)
  const seed = seeds[random(seeds.length)]
  return seed && shuffle(seed)
}

// The newest generated question of the category at or below your difficulty; questions above it wait,
// and questions already answered right are dropped. A file you asked for more about comes first.
// `last` is the question just shown: it isn't asked again straight away while a seed question is left
async function nextQuestion($: EngineInterface, category: Exclude<Category, 'tidbit'>, last?: string): Promise<Question | undefined> {
  const s = await loadSkill($)
  const known = new Set((await loadAnswered($)).map(said))
  const isSeedLeft = (await seedsLeft($, last)).length > 0
  const taken = await withQueue($, async all => {
    const queue = all.filter(q => !known.has(said(q.prompt)))
    const canTake = (q: Question) => fits(q, s) && categoryOf(q) === category && (q.id !== last || !isSeedLeft)
    const aboutFile = moreAboutFile === undefined ? -1 : queue.findIndex(q => canTake(q) && q.id !== last && q.sourceFile === moreAboutFile)
    const i = aboutFile >= 0 ? aboutFile : queue.findIndex(canTake)
    return i < 0 ? [queue, undefined] : [queue.filter((_, j) => j !== i), queue[i]]
  })
  return taken && shuffle(taken)
}

// What the round is about, whichever kind it is
const roundId = (r: Round) => (r.kind === 'tidbit' ? r.tidbit.id : r.question.id)

const countTips = async ($: EngineInterface) => {
  const count = await tidbitsReady($)
  await update($, tips, () => count)
}

// The category of a ready question about the file you asked for more about, if it has one
// (a codebase or an instruction file); once it has none ready or on the way, it's forgotten
async function moreAboutFileReady($: EngineInterface): Promise<Exclude<Category, 'tidbit'> | undefined> {
  const file = moreAboutFile
  if (file === undefined) return undefined
  const root = await $.session.root()
  const s = await loadSkill($)
  const known = new Set((await loadAnswered($)).map(said))
  const ready = (await loadQueue($)).find(q => q.sourceFile === file && fits(q, s) && !known.has(said(q.prompt)))
  const isComing = [...pending, ...(generatingFile ? [generatingFile] : [])].some(p => sameFile(root, p, file))
  if (!ready && !isComing) moreAboutFile = undefined
  return ready && categoryOf(ready)
}

// The categories are tried in an order picked by weight (see weightedOrder), until one has something
// ready; codebase questions fall back to a seed question, as does having nothing ready in any.
// While a file you asked for more about has questions ready, they come first.
// Nothing changes while the pane asks which kind you'd like more of, so no round is taken unseen
const newRound = async ($: EngineInterface) => {
  if (await read($, isAskingPreference)) return
  const last = await read($, round)
  const lastQuestion = last && last.kind !== 'tidbit' ? last.question.id : undefined
  const order = weightedOrder(await loadWeights($))
  const first = await moreAboutFileReady($)
  const tried: Category[] = first ? [first, ...order.filter(c => c !== first)] : order
  debug($, `round: trying ${tried.join(', ')}`)
  for (const category of tried) {
    if (category === 'tidbit') {
      const tidbit = await nextTidbit($)
      if (!tidbit) continue
      debug($, `round: tidbit ${tidbit.id}`)
      await update($, round, (): Round => ({ kind: 'tidbit', tidbit, reaction: null }))
      await countTips($)
      return
    }
    const question = (await nextQuestion($, category, lastQuestion)) ?? (category === 'codebase' ? await nextSeed($, lastQuestion) : undefined)
    if (!question) continue
    debug($, `round: ${question.id} ${question.sourceFile ?? '(seed)'}`)
    await update($, round, (): Round => ({ kind: 'question', question, guess: null }))
    return
  }
  const seed = await nextSeed($, lastQuestion)
  debug($, `round: ${seed ? `${seed.id} (seed)` : '(none left)'}`)
  await update($, round, (): Round | null => (seed ? { kind: 'question', question: seed, guess: null } : null))
}

// Moving on sometimes asks something first: whether you'd like more questions about the file
// the question was about, or else which kind of round you'd like more of.
// `question` is absent when moving on from a tidbit
const moveOn = async ($: EngineInterface, question?: Question) => {
  const { offerChance, preferenceChance } = await loadQuizPrefs($)
  if (question?.sourceFile && random(1000) < offerChance * 1000) {
    debug($, `offer: more about ${question.sourceFile}`)
    await update($, round, r => (r?.kind === 'question' ? { ...r, isOffering: true, chat: undefined, draft: undefined } : r))
    return
  }
  if (random(1000) < preferenceChance * 1000) {
    debug($, 'asking which kind of round you would like more of')
    await update($, isAskingPreference, () => true)
    return
  }
  await newRound($)
}

// Files Claude has read this session, waiting to be turned into questions
const pending: string[] = []
let isGenerating = false
// The file being written about, while it is
let generatingFile: string | undefined
// The kinds of question topped up when too few are ready, in the order they take turns,
// and the one topped up last
const TOP_UPS = ['codebase', 'concept', 'instructions'] as const
let lastTopUp: (typeof TOP_UPS)[number] = 'instructions'
// The project's instruction files, relative to the root, and when they were last looked for
let instructionFiles: string[] = []
let instructionsCheckedAt = -Infinity
let retryAt = 0
let isChild = false

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

// The project's instruction files, relative to the root. A skill linked from .claude/skills to
// .agents/skills is one file, so it's listed once
async function findInstructionFiles($: EngineInterface, root: string): Promise<string[]> {
  const exists = (path: string) => $.fs.exists(`${root}/${path}`).catch(() => false)
  const list = (dir: string) => $.fs.list(`${root}/${dir}`).catch(() => [])
  const candidates: string[] = [...INSTRUCTION_FILE_NAMES]
  for (const dir of SKILL_DIRS) candidates.push(...(await list(dir)).filter(e => e.kind !== 'file').map(e => `${dir}/${e.name}/SKILL.md`))
  for (const dir of AGENT_DIRS) candidates.push(...(await list(dir)).filter(e => e.name.endsWith('.md')).map(e => `${dir}/${e.name}`))
  const found: string[] = []
  const seen = new Set<string>()
  for (const path of candidates) {
    if (!(await exists(path))) continue
    const real = (await $.fs.stat(`${root}/${path}`, { resolve: true }).catch(() => undefined))?.realPath ?? path
    if (seen.has(real)) continue
    seen.add(real)
    found.push(path)
  }
  return found
}

// The root files (CLAUDE.md, AGENTS.md), then a random few of the others, in the order found
function sampleInstructionFiles(files: string[]): string[] {
  const rest = files.filter(f => !INSTRUCTION_FILE_NAMES.includes(f))
  const picked = new Set<string>()
  while (picked.size < Math.min(rest.length, INSTRUCTIONS_SAMPLE - (files.length - rest.length))) picked.add(rest[random(rest.length)]!)
  return files.filter(f => !rest.includes(f) || picked.has(f))
}

// Weighted, and never the same topic twice in a row
let lastTopic: ConceptTopic | undefined
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

function parseQuestions(text: string, difficulty: number, file?: string): Question[] {
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
const REACTIONS: [Reaction, string][] = [
  ['knew-it', 'Knew it'],
  ['new-to-me', 'New to me'],
  ['not-useful', 'Not useful'],
]

const THANKS: Record<Reaction, string> = {
  'knew-it': 'Noted: later tidbits will be a bit more advanced.',
  'new-to-me': 'Noted: later tidbits will stay at this level.',
  'not-useful': 'Noted: fewer tidbits on this topic.',
}

// A clarifying question waiting for a reply; the reply lands only if the round is still the same
let isChatting = false

async function discuss($: EngineInterface) {
  if (isChatting) return
  const current = await read($, round)
  const chat = current?.chat
  if (!current || !chat || chat.at(-1)?.from !== 'you') return

  isChatting = true
  const id = roundId(current)
  const guess = current.kind === 'tidbit' ? undefined : current.guess
  const same = (r: Round | null): r is Round =>
    r !== null && roundId(r) === id && (r.kind === 'tidbit' || r.guess === guess) && r.chat !== undefined
  const reply = (text: string) =>
    update($, round, r => (same(r) ? { ...r, chat: [...chat, { from: 'claude', text } as Message], isThinking: false } : r))
  try {
    debug($, `chat ${id}: asking claude`)
    const root = await $.session.root()
    const text =
      current.kind === 'tidbit'
        ? await askAboutTidbit($, current.tidbit, chat, root)
        : (await askClaude($, CHAT_PROMPT(current.question, chat, current.guess), { ...EDIT, cwd: root })).text
    await reply(text.trim() || '(no reply)')
  } catch (err) {
    debug($, `chat ${id}: ${String(err)}`)
    await reply('Sorry, that failed. Try asking again.')
  } finally {
    isChatting = false
  }
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

function parseIssue(text: string): { title: string; body: string } | undefined {
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
const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '') || 'issue'

async function freePath($: EngineInterface, dir: string, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const path = `${dir}/${name}${n === 1 ? '' : `-${n}`}.md`
    if (!(await $.fs.exists(path))) return path
  }
}

// Issues you've described, waiting to be rephrased and written; they outlive the round
const issues: Issue[] = []
let isFiling = false

async function fileIssue($: EngineInterface) {
  if (isFiling) return
  const issue = issues.shift()
  if (!issue) return

  isFiling = true
  const { about } = issue
  const id = about.kind === 'tidbit' ? about.tidbit.id : about.question.id
  const root = await $.session.root()
  try {
    let rephrased: { title: string; body: string } | undefined
    try {
      debug($, `issue ${id}: asking claude`)
      rephrased = parseIssue((await askClaude($, ISSUE_PROMPT(issue), { ...EDIT, cwd: root })).text)
      if (!rephrased) debug($, `issue ${id}: unparsed reply`)
    } catch (err) {
      debug($, `issue ${id}: ${String(err)}`)
    }
    // Never lose what you typed: without a rephrasing, file it as written
    const title = rephrased?.title ?? issue.text.split('\n')[0]!.slice(0, 70)
    const date = new Date().toISOString().slice(0, 10)
    const path = await freePath($, `${root}/${ISSUES_DIR}`, `${date}-${slug(title)}`)
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
    await $.fs.write(path, text)
    const shown = path.slice(root.length + 1)
    debug($, `issue ${id}: wrote ${shown}`)
    await update($, notice, () => `Filed ${shown}`)
  } catch (err) {
    debug($, `issue ${id}: ${String(err)}`)
    await update($, notice, () => 'Filing the issue failed; see .debug.log')
  } finally {
    isFiling = false
  }
}

async function generate($: EngineInterface) {
  if (isGenerating || Date.now() < retryAt) return
  const queue = await loadQueue($)
  const answered = await loadAnswered($)
  const s = await loadSkill($)
  // A file Claude read comes first; otherwise top up whichever kind has too few at or below
  // your difficulty, taking turns when several do. Instruction questions need instruction files
  const file = pending.shift()
  const fitting = queue.filter(q => fits(q, s))
  const count = (category: Category) => fitting.filter(q => categoryOf(q) === category).length
  const root = await $.session.root()
  const now = await $.clock.now()
  if (file === undefined && count('instructions') < INSTRUCTIONS_LOW && now - instructionsCheckedAt >= INSTRUCTIONS_RECHECK_MS) {
    instructionsCheckedAt = now
    instructionFiles = await findInstructionFiles($, root)
    debug($, `instruction files: ${instructionFiles.join(', ') || '(none)'}`)
  }
  const isLow = {
    codebase: count('codebase') < QUEUE_LOW,
    concept: count('concept') < CONCEPTS_LOW,
    instructions: instructionFiles.length > 0 && count('instructions') < INSTRUCTIONS_LOW,
  }
  const turn = [...TOP_UPS.slice(TOP_UPS.indexOf(lastTopUp) + 1), ...TOP_UPS].find(c => isLow[c])
  if (file === undefined && turn === undefined) return
  const shown = file?.startsWith(root + '/') ? file.slice(root.length + 1) : file
  const kind = shown === undefined ? turn! : isInstructionFile(shown) || instructionSources.has(shown) ? 'instructions' : 'codebase'
  const difficulty = difficultyOf(s)

  isGenerating = true
  generatingFile = file
  const [topic, focus] = kind === 'concept' ? pickTopic() : []
  const label = topic ? `concept ${topic}` : kind === 'instructions' ? `instructions ${shown ?? '(all)'}` : (shown ?? 'repo')
  try {
    debug($, `generate ${label} at difficulty ${difficulty}: asking claude`)
    const avoid = avoiding(queue, answered)
    if (file === undefined) lastTopUp = kind
    if (topic) lastTopic = topic
    const prompt =
      focus !== undefined
        ? CONCEPT_PROMPT(focus, difficulty, avoid)
        : kind === 'instructions'
          ? shown
            ? INSTRUCTION_FILE_PROMPT(shown, difficulty, avoid)
            : INSTRUCTIONS_PROMPT(sampleInstructionFiles(instructionFiles), difficulty, avoid)
          : shown
            ? FILE_PROMPT(shown, difficulty, avoid)
            : REPO_PROMPT(difficulty, avoid)
    const { text: reply } = await askClaude($, prompt, { ...(topic ? CONCEPT : kind === 'instructions' ? INSTRUCTIONS : CODE), cwd: root })
    // The avoid list is only a request, so drop any repeat of a question answered right
    const known = new Set(answered.map(said))
    const parsed = parseQuestions(reply, difficulty, shown)
    const questions = (
      topic
        ? parsed.map((q, i): Question => ({ ...q, id: `concept:${topic}#${Date.now()}-${i}`, sourceFile: undefined, category: 'concept', topic }))
        : kind === 'instructions'
          ? parsed.map((q, i): Question => ({ ...q, id: `instructions:${q.sourceFile ?? 'all'}#${Date.now()}-${i}`, category: 'instructions' }))
          : parsed
    ).filter(q => !known.has(said(q.prompt)))
    debug($, `generate ${label}: ${questions.length} questions`)
    if (questions.length > 0) {
      await withQueue($, async current => [[...questions, ...current], undefined])
    } else {
      debug($, `generate ${label}: unparsed reply ${JSON.stringify(reply.slice(0, 300))}`)
      // Leave instruction questions be until the files are looked for again, rather than ask every tick
      if (kind === 'instructions' && !shown) {
        instructionFiles = []
        instructionsCheckedAt = await $.clock.now()
      }
    }
  } catch (err) {
    debug($, `generate ${label}: ${String(err)}`)
    retryAt = Date.now() + RETRY_MS
  } finally {
    isGenerating = false
    generatingFile = undefined
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Inside the claude process that generates questions, stay out of the way.
    // This is DISABLE_PLUGIN_ENV_VAR from claude.ts; $.env.get needs the name spelled out
    isChild = (await $.env.get('BRAIN_UNROT_CHILD')) !== undefined
    if (isChild) return next(e)
    const result = await next(e)
    // Generation runs on a timer so it outlives the hook that queued the file
    $.clock.every(TICK_MS, () => generate($))
    $.clock.every(CHAT_TICK_MS, () => discuss($))
    $.clock.every(CHAT_TICK_MS, () => fileIssue($))
    // Tidbit research runs about once a day, apart from question generation
    $.clock.every(TICK_MS, async () => {
      if ((await refresh($)).length > 0) await countTips($)
    })
    await update($, ready, () => 0)
    void loadQueue($).then(p => update($, ready, () => p.length))
    void countTips($)
    void loadSkill($).then(s => update($, skill, () => s))
    return result
  })

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const result = await next(e)
    if (!isChild && !result.isError && !pending.includes(e.file_path)) {
      pending.push(e.file_path)
      debug($, `queued ${e.file_path}`)
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)

    // Never take the keyboard: the person clicks the pane to answer.
    // Never hold up the prompt for the pane.
    if (!e.command && !isChild) {
      debug($, `prompt accepted: ${JSON.stringify(e.text.slice(0, 60))}`)
      void newRound($)
        .then(() => $.ui.open({ id: PANE, title: 'Brain Unrot' }))
        .then(opened => debug($, `open: ${JSON.stringify(opened)}`))
        .catch(() => undefined)
    }

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = elements
    // Asking needs a text field, which not every surface has (mobile)
    const Input = 'Input' in elements ? elements.Input : undefined
    const current = await read($, round)
    const readyCount = await read($, ready)
    const tipCount = await read($, tips)
    const { difficulty } = await read($, skill)
    const status = await read($, notice)

    const isFocused = e.props.isFocused
    // Claude Code's text field doesn't reliably wrap in a docked pane: a long line
    // is cut with "…", or wraps with its second row left blank
    // (anthropics/claude-code#103858). Docked, it stays one line and the whole
    // text is echoed above it once it no longer fits.
    const isDocked = e.props.placement === 'dock'
    const field = (props: { key: string; placeholder: string; submitLabel: string; value: string; onInput: (v: string) => void; onSubmit: (v: string) => void }) => {
      if (!Input) return null
      if (!isDocked) return <Input {...props} rows={3} />
      // The frame's border and padding, the submit hint and the cursor
      const room = e.props.bodyColumns - 4 - (props.submitLabel.length + 2) - 1
      return (
        <Box flexDirection="column">
          {props.value.length > room ? (
            <>
              <Text dimColor italic>Claude Code's text box can't wrap in a side pane yet, so here's all of it:</Text>
              <Text dimColor>{props.value}</Text>
            </>
          ) : null}
          <Input {...props} />
        </Box>
      )
    }

    const frame = (body: JSX.Element) => (
      <Box flexDirection="column" gap={1} borderStyle="round" borderColor={isFocused ? 'green' : 'gray'} paddingX={1}>
        {isFocused ? (
          <Text color="green" bold>● Answering — Esc returns to chat</Text>
        ) : (
          <Text color="yellow">○ Click here to answer (or press ctrl+x, then Tab)</Text>
        )}
        {body}
        {status ? <Text dimColor>{status}</Text> : null}
        <Text dimColor>
          Difficulty {Math.floor(difficulty)} out of {DIFFICULTY_MAX} · {readyCount} generated questions ready · {tipCount} tidbits
          ready
        </Text>
      </Box>
    )

    if (await read($, isAskingPreference)) {
      const weights = await loadWeights($)
      // Instruction questions are only offered in a project that has instruction files
      const hasInstructions = instructionFiles.length > 0 || (await loadQueue($)).some(q => categoryOf(q) === 'instructions')
      const categories = CATEGORIES.filter(([category]) => category !== 'instructions' || hasInstructions)
      const answer = (category?: Category) => async () => {
        if (category) await prefer($, category)
        await update($, isAskingPreference, () => false)
        await newRound($)
      }
      return frame(
        <Box flexDirection="column" gap={1}>
          <Text bold>Which would you like more of?</Text>
          <Box flexDirection="column">
            {categories.map(([category, label], i) => (
              <Button key={`prefer-${category}`} plain hotkey={String(i + 1)} label={`${i + 1}. ${label}`} onPress={answer(category)} />
            ))}
            <Button key="prefer-none" plain hotkey="s" label="No preference" onPress={answer()} />
          </Box>
          <Text dimColor>Each kind comes up in proportion to its weight, now {categories.map(([c]) => weights[c]).join(' : ')}. Your pick adds 1.</Text>
        </Box>
      )
    }

    if (current === null) {
      // Generation doesn't start a round, so Next checks again
      return frame(
        <Box flexDirection="column" gap={1}>
          <Text dimColor>No new question yet. More are on the way.</Text>
          <Button key="next" hotkey="n" label="Next question" autoFocus onPress={() => newRound($)} />
        </Box>
      )
    }

    const { chat, issue } = current
    const heading = current.kind === 'tidbit' ? current.tidbit.headline : current.question.prompt
    const id = roundId(current)

    const ask = async () => {
      debug($, `chat ${id}: opened`)
      await update($, round, r => (r ? { ...r, chat: [] } : r))
      // Asking about a tidbit turns its topic up
      if (current.kind === 'tidbit') await react($, current.tidbit, 'asked')
      await $.ui.focus({ requestId: PANE, key: 'ask' }).catch(() => undefined)
    }

    // Kept in the round so a redraw (a reply landing, the ready count) doesn't lose it
    const type = async (text: string) => {
      await update($, round, r => (r?.chat ? { ...r, draft: text } : r))
    }

    const send = async (text: string) => {
      if (text.trim() === '') return
      // The chat timer picks this up and asks claude
      const message: Message = { from: 'you', text: text.trim() }
      await update($, round, r => (r?.chat && !r.isThinking ? { ...r, chat: [...r.chat, message], draft: '', isThinking: true } : r))
    }

    // The issue box sits on top of the round; closing it leaves the round as it was
    const report = async () => {
      debug($, `issue ${id}: opened`)
      await update($, round, r => (r ? { ...r, issue: '' } : r))
      await $.ui.focus({ requestId: PANE, key: 'issue' }).catch(() => undefined)
    }

    const describe = async (text: string) => {
      await update($, round, r => (r?.issue !== undefined ? { ...r, issue: text } : r))
    }

    const closeIssue = async () => {
      await update($, round, r => (r ? { ...r, issue: undefined } : r))
    }

    const submitIssue = async (text: string) => {
      if (text.trim() === '') return
      // The issue timer picks this up, asks claude to rephrase it and writes the file
      const about: Issue['about'] =
        current.kind === 'tidbit' ? { kind: 'tidbit', tidbit: current.tidbit } : { kind: 'question', question: current.question }
      issues.push({ text: text.trim(), about })
      await update($, notice, () => 'Filing the issue…')
      await closeIssue()
    }

    const reportButton = Input ? (
      <Button key="report" plain hotkey="7" label="7. Suggest improvement or file a bug" onPress={report} />
    ) : null

    if (issue !== undefined && Input) {
      return frame(
        <Box flexDirection="column" gap={1}>
          <Text bold>{heading}</Text>
          <Text>
            {current.kind === 'tidbit'
              ? 'What could be better? Out of date, wrong, unclear…'
              : 'What could be better? A confusing name, a bug, a wrong question…'}
          </Text>
          {field({
            key: 'issue',
            placeholder: 'Describe the issue…',
            submitLabel: 'file',
            value: issue,
            onInput: describe,
            onSubmit: submitIssue,
          })}
          <Button key="cancel-issue" plain hotkey="c" label="Cancel" onPress={closeIssue} />
          <Text dimColor>Claude rewrites it and saves it to {ISSUES_DIR}/.</Text>
        </Box>
      )
    }

    const transcript = [
      ...(chat ?? []).map((m, i) =>
        m.from === 'you' ? (
          <Text key={`msg-${i}`} color="cyan">You: {m.text}</Text>
        ) : (
          <Markdown key={`msg-${i}`} text={m.text} />
        )
      ),
      ...(current.isThinking ? [<Text key="thinking" dimColor>Claude is thinking…</Text>] : []),
    ]

    const chatBox = (placeholder: string) =>
      Input && chat ? (
        <Box flexDirection="column" gap={1}>
          {transcript}
          {field({
            key: 'ask',
            placeholder: chat.length === 0 ? placeholder : 'Ask a follow-up…',
            submitLabel: 'ask',
            value: current.draft ?? '',
            onInput: type,
            onSubmit: send,
          })}
        </Box>
      ) : null

    if (current.kind === 'tidbit') {
      const { tidbit, reaction } = current
      const now = await $.clock.now()
      const installed = await installedVersion($)

      const choose = (r: Reaction) => async () => {
        debug($, `tidbit ${tidbit.id}: ${r}`)
        await update($, round, x => (x?.kind === 'tidbit' ? { ...x, reaction: r } : x))
        await react($, tidbit, r)
        await $.ui.focus({ requestId: PANE, key: 'next' }).catch(() => undefined)
      }

      return frame(
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text bold color="yellow">💡 Did you know?</Text>
            <Text dimColor>{sourceLine(tidbit, now, installed)}</Text>
          </Box>
          <Text bold>{tidbit.headline}</Text>
          <Text>{tidbit.body}</Text>
          {tidbit.tryIt ? <Text>Try it: {tidbit.tryIt}</Text> : null}
          <Text dimColor>
            Source: {tidbit.url}
            {tidbit.lane === 'research' && !tidbit.isVerified ? ' (quote not checked)' : ''}
          </Text>
          {reaction === null ? (
            <Box flexDirection="column">
              {REACTIONS.map(([r, label], i) => (
                <Button key={r} plain hotkey={String(i + 1)} label={`${i + 1}. ${label}`} onPress={choose(r)} />
              ))}
            </Box>
          ) : (
            <Text color="green">{THANKS[reaction]}</Text>
          )}
          {chatBox('Ask about this tidbit…') ??
            (Input ? <Button key="ask" plain hotkey="6" label="6. Ask about this" onPress={ask} /> : null)}
          <Button key="next" hotkey="n" label="Next" autoFocus={reaction !== null || undefined} onPress={() => moveOn($)} />
          {reportButton}
        </Box>
      )
    }

    const { question, guess } = current

    if (current.isOffering && question.sourceFile) {
      const file = question.sourceFile
      const answer = (isYes: boolean) => async () => {
        await (isYes ? wantMore($, question, file) : wantNoMore($, file))
        await newRound($)
      }
      return frame(
        <Box flexDirection="column" gap={1}>
          <Text bold>Would you like more questions about {file}?</Text>
          <Box flexDirection="column">
            <Button key="more-yes" plain hotkey="1" label="1. Yes" onPress={answer(true)} />
            <Button key="more-no" plain hotkey="2" label="2. No" onPress={answer(false)} />
          </Box>
        </Box>
      )
    }

    const source = (
    <Text dimColor>
      {question.sourceFile
        ? `From ${question.sourceFile}`
        : isConcept(question)
          ? `General concept: ${question.topic}`
          : categoryOf(question) === 'instructions'
            ? "About the project's instructions for Claude"
            : 'Warm-up question'}
    </Text>
  )

    const choose = (i: number) => async () => {
      debug($, `guess: ${i} (answer ${question.answer})`)
      await update($, round, r => (r?.kind === 'question' ? { ...r, guess: i } : r))
      const isRight = i === question.answer
      const wasHelped = chat?.some(m => m.from === 'you') ?? false
      await record($, i === NO_IDEA ? 'no-idea' : isRight && wasHelped ? 'helped' : isRight ? 'right' : 'wrong')
      await (isRight ? remember($, question) : requeue($, question))
      // The pressed choice is gone; put the ring on Next so Enter moves on
      await $.ui.focus({ requestId: PANE, key: 'next' }).catch(() => undefined)
    }

    // A skipped question isn't asked again, and doesn't move the difficulty
    const skip = async () => {
      debug($, `skip: ${question.id}`)
      await remember($, question)
      await moveOn($, question)
    }

    const choices = (
      <Box flexDirection="column">
        {question.choices.map((c, i) => (
          <Button key={`choice-${i}`} plain hotkey={String(i + 1)} label={`${i + 1}. ${c}`} onPress={choose(i)} />
        ))}
        <Button key="no-idea" plain hotkey="5" label="5. Absolutely no idea" onPress={choose(NO_IDEA)} />
      </Box>
    )

    if (guess === null && chat && Input) {
      return frame(
        <Box flexDirection="column" gap={1}>
          {source}
          <Text bold>{question.prompt}</Text>
          {choices}
          {chatBox('Ask about the question…')}
          <Button key="skip" plain hotkey="s" label="Skip this question" onPress={skip} />
          {reportButton}
          <Text dimColor>Up or Down leaves the box: pick a choice to answer, or skip.</Text>
        </Box>
      )
    }

    if (guess === null) {
      return frame(
        <Box flexDirection="column" gap={1}>
          {source}
          <Text bold>{question.prompt}</Text>
          {choices}
          {Input ? <Button key="ask" plain hotkey="6" label="6. Ask a clarifying question" onPress={ask} /> : null}
          <Button key="skip" plain hotkey="s" label="Skip this question" onPress={skip} />
          {reportButton}
        </Box>
      )
    }

    const isRight = guess === question.answer
    const correct = `${question.answer + 1}. ${question.choices[question.answer]}`
    const verdict =
      guess === NO_IDEA ? (
        <Text bold color="yellow">No worries — it was {correct}</Text>
      ) : (
        <Text bold color={isRight ? 'green' : 'red'}>
          {isRight ? 'Correct!' : `Wrong — it was ${correct}`}
        </Text>
      )

    // A discussion from before answering carries on here, now about the answer
    const discussion =
      chatBox('Ask about the answer…') ??
      (Input ? <Button key="ask" plain hotkey="6" label="6. Ask about the answer" onPress={ask} /> : null)

    return frame(
      <Box flexDirection="column" gap={1}>
        {source}
        <Text bold>{question.prompt}</Text>
        {verdict}
        {question.explanation ? <Text>{question.explanation}</Text> : null}
        {discussion}
        <Button key="next" hotkey="n" label="Next question" autoFocus onPress={() => moveOn($, question)} />
        {reportButton}
      </Box>
    )
  })
}
