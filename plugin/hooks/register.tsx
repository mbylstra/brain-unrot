import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Question, Round, Skill } from '../types'
import { SEEDS } from './seeds'

const PANE = 'brain-unrot'
const MODEL = 'haiku'
const PANTRY_MAX = 30
// Below this many ready questions, generate some about the repo as a whole
const PANTRY_LOW = 5
const TICK_MS = 3000
const CLI_TIMEOUT_MS = 5 * 60_000
const RETRY_MS = 60_000
const CHILD_ENV = 'BRAIN_UNROT_CHILD'
// The guess recorded for "Absolutely no idea"
const NO_IDEA = -1
const LEVEL_MIN = 1
const LEVEL_MAX = 5
// Right answers in a row that move you up a level
const STREAK_UP = 3

const LEVELS: Record<number, string> = {
  1: 'extremely easy: answerable from names alone, e.g. which folder holds the tests, what a file is for',
  2: 'easy: what a function returns, what a constant is for',
  3: 'medium: how two parts connect, which case a branch handles',
  4: 'hard: why the code is written this way, what breaks if something changes',
  5: 'expert: subtle behaviour, edge cases, interactions across several files',
}

const round = atom({ plugin: 'brain-unrot', key: 'round' } as const, null as Round | null)
const ready = atom({ plugin: 'brain-unrot', key: 'ready' } as const, 0)
const skill = atom({ plugin: 'brain-unrot', key: 'skill' } as const, { level: LEVEL_MIN, streak: 0 } as Skill)

// Debug trail Claude can read back (the transcript isn't visible to it)
const trail: string[] = []

function debug($: EngineInterface, line: string) {
  trail.push(`${new Date().toISOString()} ${line}`)
  void $.fs.write(`${$.plugin.root}/.debug.log`, trail.slice(-200).join('\n') + '\n').catch(() => undefined)
}

const random = (n: number) => {
  const [r = 0] = crypto.getRandomValues(new Uint32Array(1))
  return r % n
}

// Models (and the seeds) put the right answer first far too often
function shuffle(q: Question): Question {
  const order = q.choices.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    const j = random(i + 1)
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  return { ...q, choices: order.map(i => q.choices[i]!), answer: order.indexOf(q.answer) }
}

// The pantry: generated questions kept in $.store per project, newest first
const pantryKey = async ($: EngineInterface) => `pantry:${await $.session.root()}`

async function loadPantry($: EngineInterface): Promise<Question[]> {
  const stored = await $.store.get(await pantryKey($))
  return Array.isArray(stored) ? (stored as Question[]) : []
}

async function savePantry($: EngineInterface, pantry: Question[]) {
  await $.store.set(await pantryKey($), pantry.slice(0, PANTRY_MAX))
  await update($, ready, () => Math.min(pantry.length, PANTRY_MAX))
}

// One pantry write at a time: the generator and the pane both take from it
let lock: Promise<unknown> = Promise.resolve()
function withPantry<T>($: EngineInterface, fn: (pantry: Question[]) => Promise<[Question[], T]>): Promise<T> {
  const run = lock.then(async () => {
    const [next, result] = await fn(await loadPantry($))
    await savePantry($, next)
    return result
  })
  lock = run.catch(() => undefined)
  return run
}

// Skill: a 3-up staircase per project; a wrong answer or "no idea" steps down
const skillKey = async ($: EngineInterface) => `skill:${await $.session.root()}`

const levelOf = (s: Skill) => Math.floor(s.level)
const fits = (q: Question, s: Skill) => (q.level ?? LEVEL_MIN) <= levelOf(s)

async function loadSkill($: EngineInterface): Promise<Skill> {
  const stored = (await $.store.get(await skillKey($))) as Skill | undefined
  return typeof stored?.level === 'number' ? stored : { level: LEVEL_MIN, streak: 0 }
}

function stepped(s: Skill, outcome: 'right' | 'wrong' | 'no-idea'): Skill {
  const clamp = (n: number) => Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, n))
  if (outcome === 'no-idea') return { level: clamp(s.level - 1), streak: 0 }
  if (outcome === 'wrong') return { level: clamp(s.level - 0.5), streak: 0 }
  return s.streak + 1 >= STREAK_UP ? { level: clamp(s.level + 1), streak: 0 } : { ...s, streak: s.streak + 1 }
}

async function record($: EngineInterface, outcome: 'right' | 'wrong' | 'no-idea') {
  const next = stepped(await loadSkill($), outcome)
  await $.store.set(await skillKey($), next)
  await update($, skill, () => next)
  debug($, `skill: ${outcome} -> level ${next.level}, streak ${next.streak}`)
}

async function nextQuestion($: EngineInterface): Promise<Question> {
  const s = await loadSkill($)
  // The newest question at or below your level; questions above it wait
  const taken = await withPantry($, async pantry => {
    const i = pantry.findIndex(q => fits(q, s))
    return i < 0 ? [pantry, undefined] : [pantry.filter((_, j) => j !== i), pantry[i]]
  })
  return shuffle(taken ?? SEEDS[random(SEEDS.length)]!)
}

const newRound = async ($: EngineInterface) => {
  const question = await nextQuestion($)
  debug($, `round: ${question.id} ${question.file ?? '(seed)'}`)
  await update($, round, () => ({ question, guess: null }))
}

// Files Claude has read this session, waiting to be turned into questions
const pending: string[] = []
let isGenerating = false
let retryAt = 0
let isChild = false

const FORMAT = `Each question must have exactly 4 choices and exactly one correct answer, and be answerable from the code. Keep questions and choices short; put identifiers in backticks.

Reply with JSON only, no prose and no code fence:
[{"prompt": "...", "choices": ["...", "...", "...", "..."], "answer": <index of the correct choice>, "explanation": "<one sentence>", "file": "<path of the file it is about, relative to the repo root>"}]`

const avoiding = (pantry: Question[]) =>
  pantry.length === 0 ? '' : `\n\nDon't repeat these questions:\n${pantry.map(q => `- ${q.prompt}`).join('\n')}`

const difficulty = (level: number) =>
  `Difficulty: level ${level} of ${LEVEL_MAX}, ${LEVELS[level]}. Keep every question at this level.`

const FILE_PROMPT = (file: string, level: number, pantry: Question[]) => `You write quiz questions that help a developer learn the codebase they work in.

Read ${file} and write 2 multiple-choice questions about what it does or how it fits together.

${difficulty(level)}

${FORMAT}${avoiding(pantry)}`

const REPO_PROMPT = (level: number, pantry: Question[]) => `You write quiz questions that help a developer learn the codebase they work in, which is the current directory.

Look around the repository (read at most 5 files), then write 4 multiple-choice questions: some about the overall architecture (what lives where, how the parts connect) and some about specific code.

${difficulty(level)}

${FORMAT}${avoiding(pantry)}`

function parseQuestions(text: string, level: number, file?: string): Question[] {
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
    const about = file ?? (typeof q.file === 'string' && q.file !== '' ? q.file : undefined)
    return [
      {
        id: `${about ?? 'repo'}#${Date.now()}-${i}`,
        prompt: q.prompt,
        choices: q.choices,
        answer: q.answer,
        explanation: typeof q.explanation === 'string' ? q.explanation : '',
        file: about,
        level,
      },
    ]
  })
}

// Hardcoded to the claude CLI for now; other backends can come later
async function askClaude($: EngineInterface, prompt: string, root: string): Promise<string> {
  const { exitCode, stdout, stderr } = await $.process.run(
    [
      'claude',
      '-p',
      prompt,
      '--model',
      MODEL,
      '--tools',
      'Read,Grep,Glob',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--no-session-persistence',
    ],
    // The child would load this plugin too; CHILD_ENV switches it off there
    { cwd: root, env: { [CHILD_ENV]: '1' }, stdin: '', timeoutMs: CLI_TIMEOUT_MS },
  )
  if (exitCode !== 0) throw new Error(`claude exited ${exitCode}: ${stderr.slice(0, 200)}`)
  return stdout
}

async function generate($: EngineInterface) {
  if (isGenerating || Date.now() < retryAt) return
  const pantry = await loadPantry($)
  const s = await loadSkill($)
  // A file Claude read comes first; otherwise top up with questions about the repo
  // whenever too few are at or below your level
  const file = pending.shift()
  if (file === undefined && pantry.filter(q => fits(q, s)).length >= PANTRY_LOW) return
  const level = levelOf(s)

  isGenerating = true
  const root = await $.session.root()
  const shown = file?.startsWith(root + '/') ? file.slice(root.length + 1) : file
  const label = shown ?? 'repo'
  try {
    debug($, `generate ${label} at level ${level}: asking claude`)
    const reply = await askClaude($, shown ? FILE_PROMPT(shown, level, pantry) : REPO_PROMPT(level, pantry), root)
    const questions = parseQuestions(reply, level, shown)
    debug($, `generate ${label}: ${questions.length} questions`)
    if (questions.length > 0) {
      await withPantry($, async current => [[...questions, ...current], undefined])
    } else {
      debug($, `generate ${label}: unparsed reply ${JSON.stringify(reply.slice(0, 300))}`)
    }
  } catch (err) {
    debug($, `generate ${label}: ${String(err)}`)
    retryAt = Date.now() + RETRY_MS
  } finally {
    isGenerating = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Inside the claude process that generates questions, stay out of the way
    isChild = (await $.env.get('BRAIN_UNROT_CHILD')) !== undefined
    if (isChild) return next(e)
    const result = await next(e)
    // Generation runs on a timer so it outlives the hook that queued the file
    $.clock.every(TICK_MS, () => generate($))
    await update($, ready, () => 0)
    void loadPantry($).then(p => update($, ready, () => p.length))
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
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, round)
    const readyCount = await read($, ready)
    const { level } = await read($, skill)

    const isFocused = e.props.isFocused
    const frame = (body: JSX.Element) => (
      <Box flexDirection="column" gap={1} borderStyle="round" borderColor={isFocused ? 'green' : 'gray'} paddingX={1}>
        {isFocused ? (
          <Text color="green" bold>● Answering — Esc returns to chat</Text>
        ) : (
          <Text color="yellow">○ Click here to answer (or press ctrl+x, then Tab)</Text>
        )}
        {body}
        <Text dimColor>
          Level {Math.floor(level)} of {LEVEL_MAX} · {readyCount} generated questions ready
        </Text>
      </Box>
    )

    if (current === null) {
      return frame(<Text dimColor>No question yet.</Text>)
    }

    const { question, guess } = current
    const source = <Text dimColor>{question.file ? `From ${question.file}` : 'Warm-up question'}</Text>

    const choose = (i: number) => async () => {
      debug($, `guess: ${i} (answer ${question.answer})`)
      await update($, round, r => (r ? { ...r, guess: i } : r))
      await record($, i === NO_IDEA ? 'no-idea' : i === question.answer ? 'right' : 'wrong')
      // The pressed choice is gone; put the ring on Next so Enter moves on
      await $.ui.focus({ requestId: PANE, key: 'next' }).catch(() => undefined)
    }

    if (guess === null) {
      return frame(
        <Box flexDirection="column" gap={1}>
          {source}
          <Text bold>{question.prompt}</Text>
          <Box flexDirection="column">
            {question.choices.map((c, i) => (
              <Button key={`choice-${i}`} plain hotkey={String(i + 1)} label={`${i + 1}. ${c}`} onPress={choose(i)} />
            ))}
            <Button key="no-idea" plain hotkey="5" label="5. Absolutely no idea" onPress={choose(NO_IDEA)} />
          </Box>
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

    return frame(
      <Box flexDirection="column" gap={1}>
        {source}
        <Text bold>{question.prompt}</Text>
        {verdict}
        {question.explanation ? <Text>{question.explanation}</Text> : null}
        <Button key="next" hotkey="n" label="Next question" autoFocus onPress={() => newRound($)} />
      </Box>
    )
  })
}
