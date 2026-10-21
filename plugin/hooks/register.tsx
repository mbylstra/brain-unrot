import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Issue, Message, Question, Round, Skill } from '../types'
import { SEEDS } from './seeds'

const PANE = 'brain-unrot'
const MODEL = 'haiku'
const PANTRY_MAX = 30
// Below this many ready questions, generate some about the repo as a whole
const PANTRY_LOW = 5
const TICK_MS = 3000
// How often to check for a clarifying question waiting for a reply, or an issue to file
const CHAT_TICK_MS = 1000
const ISSUES_DIR = 'docs/issues/todo'
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
// A line in the footer about the last issue filed, e.g. where it was written
const notice = atom({ plugin: 'brain-unrot', key: 'notice' } as const, null as string | null)

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

// `helped` is a right answer after a clarifying discussion: it doesn't move the level
type Outcome = 'right' | 'wrong' | 'no-idea' | 'helped'

function stepped(s: Skill, outcome: Outcome): Skill {
  const clamp = (n: number) => Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, n))
  if (outcome === 'no-idea') return { level: clamp(s.level - 1), streak: 0 }
  if (outcome === 'wrong') return { level: clamp(s.level - 0.5), streak: 0 }
  if (outcome === 'helped') return s
  return s.streak + 1 >= STREAK_UP ? { level: clamp(s.level + 1), streak: 0 } : { ...s, streak: s.streak + 1 }
}

async function record($: EngineInterface, outcome: Outcome) {
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

const CHAT_PROMPT = (q: Question, chat: Message[]) => `You help a developer with a multiple-choice quiz question about the codebase in the current directory. They've asked a clarifying question before choosing an answer.

The question${q.file ? ` (about ${q.file})` : ''}:
${q.prompt}

The choices:
${q.choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}

The correct answer is ${q.answer + 1}. Never reveal it, hint at it, or rule choices in or out: explain what the question means, the terms and concepts it uses, and the surrounding code, so they can work it out themselves. You may read the code. If they ask for the answer, say they can pick a choice or skip.

The discussion so far:
${chat.map(m => `${m.from === 'you' ? 'Developer' : 'You'}: ${m.text}`).join('\n\n')}

Reply to the developer's last message in a few short sentences of plain text. Put identifiers in backticks.`

// A clarifying question waiting for a reply; the reply lands only if the round is still the same
let isChatting = false

async function discuss($: EngineInterface) {
  if (isChatting) return
  const current = await read($, round)
  const chat = current?.chat
  if (!current || current.guess !== null || !chat || chat.at(-1)?.from !== 'you') return

  isChatting = true
  const { question } = current
  const same = (r: Round | null): r is Round => r?.question.id === question.id && r.guess === null && r.chat !== undefined
  const reply = (text: string) =>
    update($, round, r => (same(r) ? { ...r, chat: [...chat, { from: 'claude', text } as Message], isThinking: false } : r))
  try {
    debug($, `chat ${question.id}: asking claude`)
    const text = (await askClaude($, CHAT_PROMPT(question, chat), await $.session.root())).trim()
    await reply(text || '(no reply)')
  } catch (err) {
    debug($, `chat ${question.id}: ${String(err)}`)
    await reply('Sorry, that failed. Try asking again.')
  } finally {
    isChatting = false
  }
}

const ISSUE_PROMPT = (issue: Issue) => {
  const q = issue.question
  return `A developer was answering a multiple-choice quiz question about the codebase in the current directory and noticed something that could be improved or fixed. Rewrite their note as a short, clear issue for the repository.

The question${q.file ? ` (about ${q.file})` : ''}:
${q.prompt}

The choices:
${q.choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}

The correct answer is ${q.answer + 1}.${q.explanation ? ` ${q.explanation}` : ''}

Their note:
${issue.text}

You may read the code to name the file, function or variable precisely. Rephrase only what they raised: don't add other problems or fixes of your own. If the quiz question itself is wrong or misleading, say so.

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
  const { question } = issue
  const root = await $.session.root()
  try {
    let rephrased: { title: string; body: string } | undefined
    try {
      debug($, `issue ${question.id}: asking claude`)
      rephrased = parseIssue(await askClaude($, ISSUE_PROMPT(issue), root))
      if (!rephrased) debug($, `issue ${question.id}: unparsed reply`)
    } catch (err) {
      debug($, `issue ${question.id}: ${String(err)}`)
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
      `Raised while answering a Brain Unrot quiz question${question.file ? ` about \`${question.file}\`` : ''}:`,
      '',
      `> ${question.prompt}`,
      '',
      'Original note:',
      '',
      ...issue.text.split('\n').map(line => `> ${line}`),
      '',
    ].join('\n')
    await $.fs.write(path, text)
    const shown = path.slice(root.length + 1)
    debug($, `issue ${question.id}: wrote ${shown}`)
    await update($, notice, () => `Filed ${shown}`)
  } catch (err) {
    debug($, `issue ${question.id}: ${String(err)}`)
    await update($, notice, () => 'Filing the issue failed; see .debug.log')
  } finally {
    isFiling = false
  }
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
    $.clock.every(CHAT_TICK_MS, () => discuss($))
    $.clock.every(CHAT_TICK_MS, () => fileIssue($))
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
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = elements
    // Asking needs a text field, which not every surface has (mobile)
    const Input = 'Input' in elements ? elements.Input : undefined
    const current = await read($, round)
    const readyCount = await read($, ready)
    const { level } = await read($, skill)
    const status = await read($, notice)

    const isFocused = e.props.isFocused
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
          Level {Math.floor(level)} of {LEVEL_MAX} · {readyCount} generated questions ready
        </Text>
      </Box>
    )

    if (current === null) {
      return frame(<Text dimColor>No question yet.</Text>)
    }

    const { question, guess, chat, issue } = current
    const source = <Text dimColor>{question.file ? `From ${question.file}` : 'Warm-up question'}</Text>

    const choose = (i: number) => async () => {
      debug($, `guess: ${i} (answer ${question.answer})`)
      await update($, round, r => (r ? { ...r, guess: i } : r))
      const isRight = i === question.answer
      const wasHelped = chat?.some(m => m.from === 'you') ?? false
      await record($, i === NO_IDEA ? 'no-idea' : isRight && wasHelped ? 'helped' : isRight ? 'right' : 'wrong')
      // The pressed choice is gone; put the ring on Next so Enter moves on
      await $.ui.focus({ requestId: PANE, key: 'next' }).catch(() => undefined)
    }

    const ask = async () => {
      debug($, `chat ${question.id}: opened`)
      await update($, round, r => (r ? { ...r, chat: [] } : r))
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
      debug($, `issue ${question.id}: opened`)
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
      issues.push({ text: text.trim(), question })
      await update($, notice, () => 'Filing the issue…')
      await closeIssue()
    }

    const reportButton = Input ? (
      <Button key="report" plain hotkey="7" label="7. Suggest improvement or file a bug" onPress={report} />
    ) : null

    const skip = async () => {
      debug($, `skip: ${question.id}`)
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

    if (issue !== undefined && Input) {
      return frame(
        <Box flexDirection="column" gap={1}>
          {source}
          <Text bold>{question.prompt}</Text>
          <Text>What could be better? A confusing name, a bug, a wrong question…</Text>
          <Input
            key="issue"
            placeholder="Describe the issue…"
            submitLabel="file"
            value={issue}
            onInput={describe}
            onSubmit={submitIssue}
          />
          <Button key="cancel-issue" plain hotkey="c" label="Cancel" onPress={closeIssue} />
          <Text dimColor>Claude rewrites it and saves it to {ISSUES_DIR}/.</Text>
        </Box>
      )
    }

    if (guess === null && chat && Input) {
      return frame(
        <Box flexDirection="column" gap={1}>
          {source}
          <Text bold>{question.prompt}</Text>
          {choices}
          {chat.map((m, i) =>
            m.from === 'you' ? (
              <Text key={`msg-${i}`} color="cyan">You: {m.text}</Text>
            ) : (
              <Markdown key={`msg-${i}`} text={m.text} />
            )
          )}
          {current.isThinking ? <Text dimColor>Claude is thinking…</Text> : null}
          <Input
            key="ask"
            placeholder={chat.length === 0 ? 'Ask about the question…' : 'Ask a follow-up…'}
            submitLabel="ask"
            value={current.draft ?? ''}
            onInput={type}
            onSubmit={send}
          />
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

    return frame(
      <Box flexDirection="column" gap={1}>
        {source}
        <Text bold>{question.prompt}</Text>
        {verdict}
        {question.explanation ? <Text>{question.explanation}</Text> : null}
        <Button key="next" hotkey="n" label="Next question" autoFocus onPress={() => newRound($)} />
        {reportButton}
      </Box>
    )
  })
}
