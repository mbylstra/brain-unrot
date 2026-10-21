import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Issue, Message, Question, Reaction, Round, Skill, Tidbit } from '../types'
import { askClaude, CHILD_ENV, debug, random } from './claude'
import { SEEDS } from './seeds'
import { askAboutTidbit, installedVersion, loadPrefs, nextTidbit, react, refresh, sourceLine, tidbitsReady } from './tidbits'

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
// Questions read the code and its git history: Bash is limited to reading git history
const CODE = { model: MODEL, tools: ['Read', 'Grep', 'Glob', 'Bash'], allowed: ['Bash(git log:*)', 'Bash(git show:*)', 'Bash(git blame:*)'] }
// The quiz chat may also edit the issues folder, e.g. to update or file an issue the developer asks for
const CHAT = { ...CODE, tools: [...CODE.tools, 'Edit', 'Write'], allowed: [...CODE.allowed, `Edit(${ISSUES_DIR}/**)`] }
// The guess recorded for "Absolutely no idea"
const NO_IDEA = -1
const DIFFICULTY_MIN = 1
const DIFFICULTY_MAX = 5
// Right answers in a row that move the difficulty up one
const STREAK_UP = 3

const DIFFICULTIES: Record<number, string> = {
  1: 'extremely easy: answerable from names alone, e.g. which folder holds the tests, what a file is for',
  2: 'easy: what a function returns, what a constant is for',
  3: 'medium: how two parts connect, which case a branch handles',
  4: 'hard: why the code is written this way, what breaks if something changes',
  5: 'expert: subtle behaviour, edge cases, interactions across several files',
}

const round = atom({ plugin: 'brain-unrot', key: 'round' } as const, null as Round | null)
const ready = atom({ plugin: 'brain-unrot', key: 'ready' } as const, 0)
// Tidbits ready to show, not counting the seed tidbits
const tips = atom({ plugin: 'brain-unrot', key: 'tips' } as const, 0)
const skill = atom({ plugin: 'brain-unrot', key: 'skill' } as const, { difficulty: DIFFICULTY_MIN, streak: 0 } as Skill)
// A line in the footer about the last issue filed, e.g. where it was written
const notice = atom({ plugin: 'brain-unrot', key: 'notice' } as const, null as string | null)

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

// Before the rename: the queue was stored as `pantry:<root>` and difficulty as `level`
type Legacy = { level?: number }
const legacyKey = async ($: EngineInterface) => `pantry:${await $.session.root()}`

async function loadQueue($: EngineInterface): Promise<Question[]> {
  const stored = (await $.store.get(await queueKey($))) ?? (await $.store.get(await legacyKey($)))
  if (!Array.isArray(stored)) return []
  return (stored as (Question & Legacy)[]).map(({ level, ...q }) =>
    q.difficulty === undefined && level !== undefined ? { ...q, difficulty: level } : q,
  )
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

// Skill: a 3-up staircase per project; a wrong answer or "no idea" steps down
const skillKey = async ($: EngineInterface) => `skill:${await $.session.root()}`

const difficultyOf = (s: Skill) => Math.floor(s.difficulty)
const fits = (q: Question, s: Skill) => (q.difficulty ?? DIFFICULTY_MIN) <= difficultyOf(s)

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

// `last` is the question just shown: it isn't asked again straight away while a seed question is left
async function nextQuestion($: EngineInterface, last?: string): Promise<Question | undefined> {
  const s = await loadSkill($)
  const known = new Set((await loadAnswered($)).map(said))
  const seeds = SEEDS.filter(q => !known.has(said(q.prompt)) && q.id !== last)
  // The newest question at or below your difficulty; questions above it wait,
  // and questions already answered right are dropped
  const taken = await withQueue($, async all => {
    const queue = all.filter(q => !known.has(said(q.prompt)))
    const i = queue.findIndex(q => fits(q, s) && (q.id !== last || seeds.length === 0))
    return i < 0 ? [queue, undefined] : [queue.filter((_, j) => j !== i), queue[i]]
  })
  const question = taken ?? seeds[random(seeds.length)]
  return question && shuffle(question)
}

// What the round is about, whichever kind it is
const roundId = (r: Round) => (r.kind === 'tidbit' ? r.tidbit.id : r.question.id)

const countTips = async ($: EngineInterface) => {
  const count = await tidbitsReady($)
  await update($, tips, () => count)
}

// About one round in three is a tidbit, when one is ready; with no question left,
// a tidbit is better than nothing
const newRound = async ($: EngineInterface) => {
  const last = await read($, round)
  const { share } = await loadPrefs($)
  const tidbit = share > 0 && random(1000) < share * 1000 ? await nextTidbit($) : undefined
  const question = tidbit ? undefined : await nextQuestion($, last && last.kind !== 'tidbit' ? last.question.id : undefined)
  const shown = tidbit ?? (question || share === 0 ? undefined : await nextTidbit($))
  if (shown) {
    debug($, `round: tidbit ${shown.id}`)
    await update($, round, (): Round => ({ kind: 'tidbit', tidbit: shown, reaction: null }))
    await countTips($)
    return
  }
  debug($, `round: ${question ? `${question.id} ${question.file ?? '(seed)'}` : '(none left)'}`)
  await update($, round, (): Round | null => (question ? { kind: 'question', question, guess: null } : null))
}

// Files Claude has read this session, waiting to be turned into questions
const pending: string[] = []
let isGenerating = false
let retryAt = 0
let isChild = false

const FORMAT = `Each question must have exactly 4 choices and exactly one correct answer, and be answerable from the code. Keep questions and choices short; put identifiers in backticks. Name things in full words, not by a bare identifier: say "the seed questions", not "the seeds".

Reply with JSON only, no prose and no code fence:
[{"prompt": "...", "choices": ["...", "...", "...", "..."], "answer": <index of the correct choice>, "explanation": "<one sentence>", "file": "<path of the file it is about, relative to the repo root>"}]`

// Questions waiting in the queue, and ones already answered right
const avoiding = (queue: Question[], answered: string[]) => {
  const prompts = [...queue.map(q => q.prompt), ...answered.slice(-AVOID_MAX)]
  return prompts.length === 0 ? '' : `\n\nDon't repeat these questions:\n${prompts.map(p => `- ${p}`).join('\n')}`
}

const aimAt = (difficulty: number) =>
  `Difficulty: ${difficulty} of ${DIFFICULTY_MAX}, ${DIFFICULTIES[difficulty]}. Keep every question at this difficulty.`

const HISTORY = 'You may run `git log`, `git show` and `git blame` to see how and why the code got this way.'

const FILE_PROMPT = (file: string, difficulty: number, avoid: string) => `You write quiz questions that help a developer learn the codebase they work in.

Read ${file} and write 2 multiple-choice questions about what it does or how it fits together. ${HISTORY}

${aimAt(difficulty)}

${FORMAT}${avoid}`

const REPO_PROMPT = (difficulty: number, avoid: string) => `You write quiz questions that help a developer learn the codebase they work in, which is the current directory.

Look around the repository (read at most 5 files), then write 4 multiple-choice questions: some about the overall architecture (what lives where, how the parts connect) and some about specific code. ${HISTORY}

${aimAt(difficulty)}

${FORMAT}${avoid}`

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
    const about = file ?? (typeof q.file === 'string' && q.file !== '' ? q.file : undefined)
    return [
      {
        id: `${about ?? 'repo'}#${Date.now()}-${i}`,
        prompt: q.prompt,
        choices: q.choices,
        answer: q.answer,
        explanation: typeof q.explanation === 'string' ? q.explanation : '',
        file: about,
        difficulty,
      },
    ]
  })
}

// Before an answer, claude explains without giving it away; after, it explains the answer
const CHAT_PROMPT = (q: Question, chat: Message[], guess: number | null) => `You help a developer with a multiple-choice quiz question about the codebase in the current directory. ${
  guess === null ? "They've asked a clarifying question before choosing an answer." : 'They have answered and seen the correct answer, and have a question about it.'
}

The question${q.file ? ` (about ${q.file})` : ''}:
${q.prompt}

The choices:
${q.choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}

${
  guess === null
    ? `The correct answer is ${q.answer + 1}. Never reveal it, hint at it, or rule choices in or out: explain what the question means, the terms and concepts it uses, and the surrounding code, so they can work it out themselves. You may read the code. If they ask for the answer, say they can pick a choice or skip.`
    : `The correct answer is ${q.answer + 1}.${q.explanation ? ` ${q.explanation}` : ''} They chose ${
        guess === NO_IDEA ? '"Absolutely no idea"' : guess + 1
      }. Help them understand why the answer is right and the others are not. You may read the code.`
}

The discussion so far:
${chat.map(m => `${m.from === 'you' ? 'Developer' : 'You'}: ${m.text}`).join('\n\n')}

If they ask you to file or change an issue, you may edit files in \`${ISSUES_DIR}\` (one markdown file per issue), and nothing else.

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
        : (await askClaude($, CHAT_PROMPT(current.question, chat, current.guess), { ...CHAT, cwd: root })).text
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
      : `A developer was answering a multiple-choice quiz question about the codebase in the current directory and noticed something that could be improved or fixed. Rewrite their note as a short, clear issue for the repository.

The question${about.question.file ? ` (about ${about.question.file})` : ''}:
${about.question.prompt}

The choices:
${about.question.choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}

The correct answer is ${about.question.answer + 1}.${about.question.explanation ? ` ${about.question.explanation}` : ''}`
  return `${context}

Their note:
${issue.text}

You may read the code to name the file, function or variable precisely. Rephrase only what they raised: don't add other problems or fixes of your own. If the ${about.kind === 'tidbit' ? 'tip' : 'quiz question'} itself is wrong or misleading, say so.

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
      rephrased = parseIssue((await askClaude($, ISSUE_PROMPT(issue), { ...CODE, cwd: root })).text)
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
            `Raised while answering a Brain Unrot quiz question${about.question.file ? ` about \`${about.question.file}\`` : ''}:`,
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
  // A file Claude read comes first; otherwise top up with questions about the repo
  // whenever too few are at or below your difficulty
  const file = pending.shift()
  if (file === undefined && queue.filter(q => fits(q, s)).length >= QUEUE_LOW) return
  const difficulty = difficultyOf(s)

  isGenerating = true
  const root = await $.session.root()
  const shown = file?.startsWith(root + '/') ? file.slice(root.length + 1) : file
  const label = shown ?? 'repo'
  try {
    debug($, `generate ${label} at difficulty ${difficulty}: asking claude`)
    const avoid = avoiding(queue, answered)
    const { text: reply } = await askClaude($, shown ? FILE_PROMPT(shown, difficulty, avoid) : REPO_PROMPT(difficulty, avoid), {
      ...CODE,
      cwd: root,
    })
    // The avoid list is only a request, so drop any repeat of a question answered right
    const known = new Set(answered.map(said))
    const questions = parseQuestions(reply, difficulty, shown).filter(q => !known.has(said(q.prompt)))
    debug($, `generate ${label}: ${questions.length} questions`)
    if (questions.length > 0) {
      await withQueue($, async current => [[...questions, ...current], undefined])
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
          <Button key="next" hotkey="n" label="Next" autoFocus={reaction !== null || undefined} onPress={() => newRound($)} />
          {reportButton}
        </Box>
      )
    }

    const { question, guess } = current
    const source = <Text dimColor>{question.file ? `From ${question.file}` : 'Warm-up question'}</Text>

    const choose = (i: number) => async () => {
      debug($, `guess: ${i} (answer ${question.answer})`)
      await update($, round, r => (r && r.kind !== 'tidbit' ? { ...r, guess: i } : r))
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
      await newRound($)
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
        <Button key="next" hotkey="n" label="Next question" autoFocus onPress={() => newRound($)} />
        {reportButton}
      </Box>
    )
  })
}
