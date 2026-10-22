import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Prefs } from '../types'
import { SEED_TIDBITS, SEEDS } from '../hooks/seeds'
import { CHANGELOG_URL, compareVersions, plain, RELEASES_URL, splitChangelog } from '../hooks/tidbits'

const PANE = {
  plugin: 'brain-unrot',
  component: 'Pane',
  requestId: 'brain-unrot',
  props: {
    title: 'Brain Unrot',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const REPLY = JSON.stringify([
  {
    prompt: 'What does `loadConfig` return when the file is missing?',
    choices: ['The defaults', 'null', 'It throws', 'An empty string'],
    answer: 0,
    explanation: 'It falls back to the defaults.',
    sourceFile: 'src/config.ts',
  },
  { prompt: 'Broken question', choices: ['only two', 'choices'], answer: 0 },
])

const CHAT_REPLY = 'It asks what the function hands back when there is no file to read.'

const ISSUE_REPLY = JSON.stringify({
  title: 'Rename `x` in loadConfig/to something clearer',
  body: 'In `src/config.ts`, `loadConfig` names its result `x`. Call it `config`.',
})

const FILLER = { prompt: 'Filler?', choices: ['a', 'b', 'c', 'd'], answer: 0, explanation: '', sourceFile: 'x.ts' }

const CONCEPT = {
  id: 'concept',
  prompt: 'Why hash passwords with a slow, salted function?',
  choices: ['To make brute force costly', 'To save space', 'To speed up logins', 'To allow decryption'],
  answer: 0,
  explanation: 'A slow hash makes each guess expensive.',
  category: 'concept',
  topic: 'security',
}

// Enough of both kinds at difficulty 1 that nothing needs generating
const FULL_QUEUE = [
  ...Array.from({ length: 5 }, (_, i) => ({ ...FILLER, id: `filler-${i}`, prompt: `Filler ${i}?` })),
  ...Array.from({ length: 2 }, (_, i) => ({ ...CONCEPT, id: `concept-${i}`, prompt: `Concept ${i}?` })),
]

const CODEBASE_QUEUE = FULL_QUEUE.filter(q => !('category' in q))

// Tidbits stay out of the way: none are shown, and both lanes ran just now
const NO_TIDBITS = { 'tidbits:prefs': { share: 0 }, 'tidbits:cursor': { changelogAt: 0, researchedAt: 0 } }
// Moving on never asks whether you'd like more questions about the file, unless a test says so
const NO_OFFERS = { 'quiz:prefs': { offerChance: 0 } }
const ALWAYS_OFFER = { 'quiz:prefs': { offerChance: 1 } }

type Page = { status: number; text: string; headers?: Record<string, string> }

// Stands in for the engine; returns the argv of each claude CLI call.
// `structured` answers the calls that ask for JSON output, and `pages` the fetches
function world(
  on: On,
  store: Record<string, unknown> = {},
  env: Record<string, string> = {},
  { now = 0, structured = () => ({}), pages = {} }: { now?: number; structured?: (prompt: string) => unknown; pages?: Record<string, Page> } = {},
) {
  const opened: string[] = []
  const clock = mock.clock(on, { now })
  // The store, kept here so a test can look at what was saved
  const saved: Record<string, unknown> = structuredClone({ ...NO_TIDBITS, ...NO_OFFERS, ...store })
  on('store.get', (_, e) => ({ value: saved[e.key] }))
  on('store.set', (_, e) => {
    saved[e.key] = structuredClone(e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete saved[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(saved) }))
  mock.env(on, env)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: {} }))
  const written: { path: string; text: string }[] = []
  on('fs.write', (_, e) => {
    if (!e.path.endsWith('.debug.log')) written.push(e)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: written.some(w => w.path === e.path) }))
  const fetched: { url: string; headers?: Record<string, string> }[] = []
  on('http.fetch', (_, e) => {
    fetched.push({ url: e.url, headers: e.init?.headers })
    const page = pages[e.url] ?? { status: 404, text: '' }
    return { value: { status: page.status, ok: page.status >= 200 && page.status < 300, headers: page.headers ?? {}, text: page.text } }
  })
  const calls: { argv: readonly string[]; env?: Readonly<Record<string, string>> }[] = []
  on('process.run', (_, e) => {
    const out = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[1] === '--version') return out('2.1.305 (Claude Code)')
    if (e.argv[1] === '--help') return out('Usage: claude [options]\n  --model <model>\n  --resume')
    calls.push({ argv: e.argv, env: e.init?.env })
    const prompt = e.argv[2] ?? ''
    if (e.argv.includes('--json-schema')) {
      return out(JSON.stringify({ type: 'result', result: '', structured_output: structured(prompt), total_cost_usd: 0.01 }))
    }
    const stdout = prompt.startsWith('You help a developer')
      ? CHAT_REPLY
      : prompt.includes('Rewrite their note')
        ? ISSUE_REPLY
        : REPLY
    return out(stdout)
  })
  return { clock, calls, opened, written, fetched, store: saved }
}

test('a warm-up question shows at once, and the queue fills with repo questions', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Warm-up question/ })).toBeTruthy()

  // The queue is low, so the next tick asks claude about the repo as a whole
  await clock.advance(3000)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.argv.slice(0, 2)).toEqual(['claude', '-p'])
  expect(calls[0]!.argv[2]).toContain('Look around the repository')
  expect(calls[0]!.env).toEqual({ BRAIN_UNROT_CHILD: '1' })
  // It may read git history, and nothing else through Bash
  const argv = calls[0]!.argv
  expect(argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--permission-mode'))).toEqual([
    'Bash(git log:*)',
    'Bash(git show:*)',
    'Bash(git blame:*)',
  ])
  expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk')
  expect(await ui.find({ type: 'Text', text: /1 generated questions ready/ })).toBeTruthy()

  await ui.press({ key: 'choice-0' })
  expect(await ui.find({ type: 'Text', text: /Correct!|Wrong/ })).toBeTruthy()
  await ui.press({ key: 'next' })

  expect(await ui.find({ type: 'Text', text: /From src\/config\.ts/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /loadConfig/ })).toBeTruthy()
  await ui.unmount()
})

test('a file Claude reads becomes questions, even with a full queue', async ($, on) => {
  const { clock, calls } = world(on, { 'queue:/repo': FULL_QUEUE })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await clock.advance(3000)
  expect(calls).toHaveLength(0)

  await $.tool.call({ tool: 'Read', file_path: '/repo/src/config.ts' })
  await clock.advance(3000)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.argv[2]).toContain('Read src/config.ts')
})

test('with few concept questions ready, Sonnet writes some about general programming', async ($, on) => {
  const { clock, calls, store } = world(on, { 'queue:/repo': CODEBASE_QUEUE })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await clock.advance(3000)
  expect(calls).toHaveLength(1)
  const argv = calls[0]!.argv
  expect(argv[2]).toContain("keep a developer's general programming knowledge sharp")
  expect(argv[2]).toContain('Never ask about syntax')
  expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet')
  // It only glances at the project: no Bash
  expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob')
  expect(argv).not.toContain('--allowedTools')
  expect(argv).toContain('--max-budget-usd')

  const [generated] = store['queue:/repo'] as { category?: string; topic?: string; sourceFile?: string; id: string }[]
  expect(generated!.category).toBe('concept')
  expect(generated!.topic).toBeTruthy()
  expect(generated!.sourceFile).toBeUndefined()
  expect(generated!.id.startsWith('concept:')).toBe(true)
})

test('with both kinds low, codebase and concept questions take turns', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await clock.advance(3000)
  await clock.advance(3000)
  expect(calls).toHaveLength(2)
  expect(calls[0]!.argv[2]).toContain('Look around the repository')
  expect(calls[1]!.argv[2]).toContain('general programming knowledge')
})

test('a concept question says what it is about, and the chat knows it is not about the code', async ($, on) => {
  const { clock, calls } = world(on, { 'queue:/repo': [CONCEPT], 'answered:/repo': SEEDS.map(q => q.prompt) })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /General concept: security/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /slow, salted function/ })).toBeTruthy()

  await ui.press({ key: 'ask' })
  await ui.input({ key: 'ask', text: 'What is a salt?' })
  await clock.advance(1000)
  const chat = calls.find(c => c.argv[2]!.startsWith('You help a developer'))!
  expect(chat.argv[2]).toContain('about a general programming concept (security)')
  await ui.unmount()
})

test('a queue, difficulty and source file stored under the old names still load', async ($, on) => {
  const { sourceFile: _, ...filler } = FILLER
  const known = { ...filler, id: 'known', prompt: 'An old question?', level: 2, file: 'old.ts' }
  const { clock } = world(on, { 'skill:/repo': { level: 2, streak: 1 }, 'pantry:/repo': [known] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Difficulty 2 out of 5/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /An old question\?/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /From old\.ts/ })).toBeTruthy()
  await ui.unmount()
})

test('inside the generating claude process the plugin stays quiet', async ($, on) => {
  const { clock, calls, opened } = world(on, {}, { BRAIN_UNROT_CHILD: '1' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })

  await $.tool.call({ tool: 'Read', file_path: '/repo/src/config.ts' })
  await $.prompt.submit({ text: 'write questions', wait: false, origin: { kind: 'composer' } })
  await clock.advance(10_000)
  expect(calls).toHaveLength(0)
  expect(opened).toEqual([])
})

test('"Absolutely no idea" reveals the answer and steps the difficulty down', async ($, on) => {
  const { clock, calls } = world(on, { 'skill:/repo': { difficulty: 3, streak: 2 } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Difficulty 3 out of 5/ })).toBeTruthy()

  await ui.press({ key: 'no-idea' })
  expect(await ui.find({ type: 'Text', text: /No worries — it was/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Difficulty 2 out of 5/ })).toBeTruthy()

  // The next questions are asked for at the new difficulty
  await clock.advance(3000)
  expect(calls[0]!.argv[2]).toContain('Difficulty: 2 of 5')
  await ui.unmount()
})

test('after the answer is shown you can ask about it', async ($, on) => {
  const known = { ...FILLER, id: 'known', choices: ['right one', 'b', 'c', 'd'], difficulty: 1 }
  const { clock, calls } = world(on, { 'skill:/repo': { difficulty: 2, streak: 2 }, 'queue:/repo': [known] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'no-idea' })
  expect(await ui.find({ type: 'Text', text: /No worries — it was/ })).toBeTruthy()
  await ui.press({ key: 'ask' })
  await ui.input({ key: 'ask', text: 'Why not b?' })
  expect(await ui.find({ type: 'Text', text: /You: Why not b\?/ })).toBeTruthy()

  // Now claude may explain the answer
  await clock.advance(1000)
  const chat = calls.find(c => c.argv[2]?.includes('seen the correct answer'))!
  expect(chat.argv[2]).not.toContain('Never reveal it')
  expect(chat.argv[2]).toContain('They chose "Absolutely no idea"')
  expect(chat.argv[2]).toContain('Developer: Why not b?')
  expect(await ui.find({ type: 'Markdown', text: /no file to read/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /No worries — it was/ })).toBeTruthy()

  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Button', key: 'ask', text: /Ask a clarifying question/ })).toBeTruthy()
  await ui.unmount()
})

test('a clarifying question opens a discussion, and you can then answer or skip', async ($, on) => {
  const known = { ...FILLER, id: 'known', choices: ['right one', 'b', 'c', 'd'], difficulty: 1 }
  const { clock, calls } = world(on, { 'skill:/repo': { difficulty: 2, streak: 2 }, 'queue:/repo': [known] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'ask' })
  await ui.input({ key: 'ask', text: 'What does', kind: 'change' })
  expect((await ui.find({ type: 'Input', key: 'ask' }))?.text).toBe('What does')
  // Docked, a field cuts a long line, so the whole draft is echoed above it
  expect(await ui.find({ type: 'Text', text: 'What does' })).toBeFalsy()
  const long = 'What does it mean for the file to be missing, and is that the same as an empty file?'
  await ui.input({ key: 'ask', text: long, kind: 'change' })
  expect(await ui.find({ type: 'Text', text: long })).toBeTruthy()
  await ui.input({ key: 'ask', text: 'What does "missing" mean here?' })
  expect((await ui.find({ type: 'Input', key: 'ask' }))?.text).toBe('')
  expect(await ui.find({ type: 'Text', text: /You: What does "missing" mean here\?/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Claude is thinking/ })).toBeTruthy()

  // The chat timer asks claude, with the question and the discussion so far
  await clock.advance(1000)
  const chat = calls.find(c => c.argv[2]?.includes('clarifying question'))!
  expect(chat.argv[2]).toContain('Never reveal it')
  expect(chat.argv[2]).toContain('Developer: What does "missing" mean here?')
  // It may edit the issues folder, and no other files
  expect(chat.argv[chat.argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Bash,Edit,Write')
  expect(chat.argv.slice(chat.argv.indexOf('--allowedTools') + 1, chat.argv.indexOf('--permission-mode'))).toEqual([
    'Bash(git log:*)',
    'Bash(git show:*)',
    'Bash(git blame:*)',
    'Edit(docs/issues/todo/**)',
  ])
  expect(await ui.find({ type: 'Markdown', text: /no file to read/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Claude is thinking/ })).toBeFalsy()

  // Answering after a discussion reveals the answer; a right one doesn't move the difficulty
  const right = await ui.find({ type: 'Button', text: /right one/ })
  await ui.press({ key: right!.key! })
  expect(await ui.find({ type: 'Text', text: /Correct!/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Difficulty 2 out of 5/ })).toBeTruthy()
  await ui.press({ key: 'next' })

  // Skipping moves straight on to the next question, difficulty unchanged
  await ui.press({ key: 'ask' })
  await ui.press({ key: 'skip' })
  expect(await ui.find({ type: 'Input', key: 'ask' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'ask', text: /Ask a clarifying question/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Difficulty 2 out of 5/ })).toBeTruthy()
  await ui.unmount()
})

test('a skipped question is not asked again', async ($, on) => {
  const known = { ...FILLER, id: 'known', prompt: 'Which folder holds the tests?' }
  const { clock, store } = world(on, { 'queue:/repo': [known], 'answered:/repo': SEEDS.map(q => q.prompt) })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Which folder holds the tests\?/ })).toBeTruthy()
  await ui.press({ key: 'skip' })
  expect(await ui.find({ type: 'Text', text: /No new question yet/ })).toBeTruthy()
  expect(store['answered:/repo']).toContain('Which folder holds the tests?')
  await ui.unmount()
})

test('an issue you describe is rephrased and written to docs/issues/todo', async ($, on) => {
  const known = { ...FILLER, id: 'known', prompt: 'What is `x` in loadConfig?', sourceFile: 'src/config.ts', difficulty: 1 }
  const { clock, calls, written } = world(on, { 'skill:/repo': { difficulty: 2, streak: 2 }, 'queue:/repo': [known] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Cancelling leaves the round as it was
  await ui.press({ key: 'report' })
  expect(await ui.find({ type: 'Input', key: 'issue' })).toBeTruthy()
  await ui.press({ key: 'cancel-issue' })
  expect(await ui.find({ type: 'Input', key: 'issue' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'ask' })).toBeTruthy()

  // Answer first: the reveal is where a bad name usually shows up
  await ui.press({ key: 'choice-0' })
  const difficultyBefore = (await ui.find({ type: 'Text', text: /Difficulty \d out of 5/ }))?.text
  await ui.press({ key: 'report' })
  await ui.input({ key: 'issue', text: 'x is a terrible name' })
  expect(await ui.find({ type: 'Text', text: /Filing the issue/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'next' })).toBeTruthy()

  await clock.advance(1000)
  const ask = calls.find(c => c.argv[2]?.includes('Rewrite their note'))!
  expect(ask.argv[2]).toContain('x is a terrible name')
  expect(ask.argv[2]).toContain('What is `x` in loadConfig?')

  expect(written).toHaveLength(1)
  const [issue] = written
  expect(issue!.path).toMatch(/^\/repo\/docs\/issues\/todo\/\d{4}-\d{2}-\d{2}-rename-x-in-loadconfig-to-something-clearer\.md$/)
  expect(issue!.text).toContain('# Rename `x` in loadConfig/to something clearer')
  expect(issue!.text).toContain('Call it `config`.')
  expect(issue!.text).toContain('> x is a terrible name')
  expect(issue!.text).toContain('about `src/config.ts`')
  expect(await ui.find({ type: 'Text', text: /Filed docs\/issues\/todo\// })).toBeTruthy()

  // Filing doesn't move the difficulty, and a second issue with the same title gets its own file
  expect((await ui.find({ type: 'Text', text: /Difficulty \d out of 5/ }))?.text).toBe(difficultyBefore)
  await ui.press({ key: 'report' })
  await ui.input({ key: 'issue', text: 'still a terrible name' })
  await clock.advance(1000)
  expect(written).toHaveLength(2)
  expect(written[1]!.path).toMatch(/clearer-2\.md$/)
  await ui.unmount()
})

test('a question answered right is not asked again, and generation is told to avoid it', async ($, on) => {
  const known = { ...FILLER, id: 'known', prompt: 'Which folder holds the tests?', choices: ['right one', 'b', 'c', 'd'] }
  const seeds = SEEDS.map(q => q.prompt)
  const { clock, calls } = world(on, { 'queue:/repo': [known], 'answered:/repo': seeds })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: (await ui.find({ type: 'Button', text: /right one/ }))!.key! })
  expect(await ui.find({ type: 'Text', text: /Correct!/ })).toBeTruthy()

  // Every seed question is answered too, so there's nothing left to ask yet
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /No new question yet/ })).toBeTruthy()

  await clock.advance(3000)
  expect(calls[0]!.argv[2]).toMatch(/Don't repeat these questions:\n(- .*\n)*- Which folder holds the tests\?$/)
  expect(await ui.find({ type: 'Text', text: /1 generated questions ready/ })).toBeTruthy()
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /loadConfig/ })).toBeTruthy()
  await ui.unmount()
})

test('a regenerated question you already answered right is dropped', async ($, on) => {
  const { clock } = world(on, { 'answered:/repo': ['What does `loadConfig` return when the file is missing?'] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await clock.advance(3000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /0 generated questions ready/ })).toBeTruthy()
  await ui.unmount()
})

test('a question answered wrong comes round again', async ($, on) => {
  const known = { ...FILLER, id: 'known', choices: ['right one', 'b', 'c', 'd'] }
  const { clock } = world(on, { 'queue:/repo': [known] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: (await ui.find({ type: 'Button', text: /\. b$/ }))!.key! })
  expect(await ui.find({ type: 'Text', text: /Wrong/ })).toBeTruthy()

  // Not straight away while a seed question is left
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /Warm-up question/ })).toBeTruthy()
  await ui.press({ key: 'no-idea' })
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /Filler\?/ })).toBeTruthy()
  await ui.unmount()
})

test('saying yes to more questions about a file puts its questions first, and writes more when few are left', async ($, on) => {
  const shown = { ...FILLER, id: 'shown', prompt: 'Shown?', sourceFile: 'src/config.ts', choices: ['right one', 'b', 'c', 'd'] }
  const other = { ...FILLER, id: 'other', prompt: 'Other?' }
  const config = { ...FILLER, id: 'config', prompt: 'Config?', sourceFile: 'src/config.ts' }
  const { clock, calls, store } = world(on, {
    ...ALWAYS_OFFER,
    // No concept questions, so the first one shown isn't left to chance
    'queue:/repo': [shown, other, config, ...CODEBASE_QUEUE],
    'answered:/repo': SEEDS.map(q => q.prompt),
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Shown\?/ })).toBeTruthy()
  await ui.press({ key: (await ui.find({ type: 'Button', text: /right one/ }))!.key! })
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /Would you like more questions about src\/config\.ts\?/ })).toBeTruthy()

  // The file's questions come before tidbits, however often those are shown
  store['tidbits:prefs'] = { share: 1 }
  await ui.press({ key: 'more-yes' })
  expect(await ui.find({ type: 'Text', text: /Config\?/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Did you know/ })).toBeFalsy()

  // Only one was ready, so the next tick writes more about the file
  await clock.advance(3000)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.argv[2]).toContain('Read src/config.ts')
  const [generated] = store['queue:/repo'] as { sourceFile?: string }[]
  expect(generated!.sourceFile).toBe('src/config.ts')
  await ui.unmount()
})

test('skipping can ask about more questions too, and no sends the file\'s questions to the back', async ($, on) => {
  const shown = { ...FILLER, id: 'shown', prompt: 'Shown?', sourceFile: 'src/config.ts' }
  const config = { ...FILLER, id: 'config', prompt: 'Config?', sourceFile: 'src/config.ts' }
  const { clock, calls, store } = world(on, {
    ...ALWAYS_OFFER,
    'queue:/repo': [shown, config, ...CODEBASE_QUEUE],
    'answered:/repo': SEEDS.map(q => q.prompt),
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Shown\?/ })).toBeTruthy()
  await ui.press({ key: 'skip' })
  expect(await ui.find({ type: 'Text', text: /Would you like more questions about src\/config\.ts\?/ })).toBeTruthy()

  await ui.press({ key: 'more-no' })
  expect(await ui.find({ type: 'Text', text: /Config\?/ })).toBeFalsy()
  expect((store['queue:/repo'] as { id: string }[]).at(-1)!.id).toBe('config')

  // Concept questions are written, as there are none, but nothing more about the file
  await clock.advance(3000)
  expect(calls.some(c => c.argv[2]!.includes('src/config.ts'))).toBe(false)
  await ui.unmount()
})

// --- Did you know ---

const NOW = Date.parse('2026-10-21T12:00:00Z')

const CHANGELOG = `# Changelog

## 2.1.306

- Fixed a crash when the terminal is resized

## 2.1.305

- Added \`/effort\` to choose how hard Claude thinks
- Fixed a typo in \`/usage\`

## 2.1.100

- Added something long ago
`

const RELEASES = JSON.stringify([
  { tag_name: 'v2.1.306', published_at: '2026-10-21T03:00:00Z' },
  { tag_name: 'v2.1.305', published_at: '2026-10-20T00:00:00Z' },
  { tag_name: 'v2.1.100', published_at: '2026-06-01T00:00:00Z' },
])

const TIP = {
  id: 'research:tip',
  headline: 'Keep a scratchpad file for long plans.',
  body: 'Claude can re-read it after a `/compact`.',
  url: 'https://example.com/tip',
  publishedAt: '2026-10-18T00:00:00.000Z',
  quote: 'Keep a scratchpad.',
  topic: 'context management',
  lane: 'research',
  expiresAt: '2026-12-31T00:00:00.000Z',
  isVerified: true,
}

test('the CHANGELOG splits into releases, compared by number', async () => {
  const releases = splitChangelog(CHANGELOG)
  expect(releases.map(r => r.version)).toEqual(['2.1.306', '2.1.305', '2.1.100'])
  expect(releases[1]!.lines).toEqual(['Added `/effort` to choose how hard Claude thinks', 'Fixed a typo in `/usage`'])
  expect(compareVersions('2.1.99', '2.1.306')).toBeLessThan(0)
  expect(compareVersions('2.2.0', '2.1.306')).toBeGreaterThan(0)
  expect(plain('<p>Use <code>a</code>&nbsp;&amp; “b”</p>')).toBe('use a & "b"')
})

test('new CHANGELOG releases become tidbits, grounded in the line they quote', async ($, on) => {
  const structured = (prompt: string) =>
    prompt.includes('release notes')
      ? {
          tidbits: [
            {
              headline: '`/effort` sets how hard Claude thinks.',
              body: 'Turn it down for routine edits.',
              quote: 'Added `/effort` to choose how hard Claude thinks',
              version: '2.1.305',
              topic: 'cost and model choice',
            },
            { headline: 'Claude can teleport.', body: 'Made up.', quote: 'Added teleporting', version: '2.1.305', topic: 'prompting' },
          ],
        }
      : { items: [] }
  const pages = {
    [CHANGELOG_URL]: { status: 200, text: CHANGELOG, headers: { etag: '"abc"' } },
    [RELEASES_URL]: { status: 200, text: RELEASES },
  }
  const { clock, calls, fetched, store } = world(
    on,
    { 'tidbits:prefs': { share: 1 }, 'tidbits:cursor': { researchedAt: NOW } },
    {},
    { now: NOW, structured, pages },
  )
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)

  // Only the releases from the last two months go to the model, which has no tools
  const digest = calls.find(c => c.argv[2]?.includes('release notes'))!
  expect(digest.argv[2]).toContain('Added `/effort` to choose how hard Claude thinks')
  expect(digest.argv[2]).not.toContain('long ago')
  expect(digest.argv[digest.argv.indexOf('--model') + 1]).toBe('sonnet')
  expect(digest.argv[digest.argv.indexOf('--tools') + 1]).toBe('')
  expect(digest.argv).toContain('--max-budget-usd')

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Did you know/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /`\/effort` sets how hard/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Claude Code 2\.1\.305 · in your version · yesterday/ })).toBeTruthy()

  // The made-up one was dropped, so there's nothing else ready
  expect(await ui.find({ type: 'Text', text: /0 tidbits ready/ })).toBeTruthy()

  // The cursor moves past the newest release, with its ETag for next time
  expect(store['tidbits:cursor']).toMatchObject({ version: '2.1.306', etag: '"abc"', installed: '2.1.305', changelogAt: NOW + 3000 })
  expect(fetched.map(f => f.url)).toEqual([CHANGELOG_URL, RELEASES_URL])
  await ui.unmount()
})

test('an unchanged CHANGELOG is not downloaded or sent to the model again', async ($, on) => {
  const pages = { [CHANGELOG_URL]: { status: 304, text: '' } }
  const cursor = { version: '2.1.306', etag: '"abc"', changelogAt: NOW - 86_400_000, researchedAt: NOW }
  const { clock, calls, fetched, store } = world(on, { 'tidbits:cursor': cursor }, {}, { now: NOW, pages })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)

  expect(fetched).toEqual([{ url: CHANGELOG_URL, headers: { 'If-None-Match': '"abc"' } }])
  expect(calls.filter(c => c.argv.includes('--json-schema'))).toHaveLength(0)
  expect(store['tidbits:cursor']).toMatchObject({ version: '2.1.306', changelogAt: NOW + 3000 })
})

test('research runs again within the hour when few tidbits are ready', async ($, on) => {
  const cursor = { changelogAt: NOW, researchedAt: NOW - 2 * 60 * 60_000 }
  const tidbits = Array.from({ length: 4 }, (_, i) => ({ ...TIP, id: `research:${i}`, headline: `Tip ${i}` }))
  const { clock, calls } = world(on, { 'tidbits:cursor': cursor, tidbits }, {}, { now: NOW })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(calls.some(c => c.argv.includes('--json-schema'))).toBe(true)
})

test('research waits a day while enough tidbits are ready', async ($, on) => {
  const cursor = { changelogAt: NOW, researchedAt: NOW - 2 * 60 * 60_000 }
  const tidbits = Array.from({ length: 5 }, (_, i) => ({ ...TIP, id: `research:${i}`, headline: `Tip ${i}` }))
  const { clock, calls } = world(on, { 'tidbits:cursor': cursor, tidbits }, {}, { now: NOW })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(calls.some(c => c.argv.includes('--json-schema'))).toBe(false)
})

test('research keeps only dated items whose quote is on the page', async ($, on) => {
  const filler = 'Some words about agents. '.repeat(40)
  const item = (path: string, publishedAt: string, extra: object = {}) => ({
    url: `https://example.com/${path}`,
    publishedAt,
    quote: 'Run the tests before you commit.',
    headline: `Tip ${path}`,
    body: 'Tests catch what review misses.',
    ...extra,
  })
  const structured = () => ({
    items: [
      item('found', '2026-10-15'),
      item('missing', '2026-10-15'),
      item('down', '2026-10-17'),
      item('old', '2026-08-01'),
      item('flag', '2026-10-15', { body: 'Run `claude --teleport` to move.' }),
      item('dupe', '2026-10-15', { headline: TIP.headline }),
    ],
  })
  const pages = {
    'https://example.com/found': { status: 200, text: `<p>${filler}</p><p>Run the <code>tests</code> before you&nbsp;commit.</p>` },
    'https://example.com/missing': { status: 200, text: `<p>${filler}</p>` },
    'https://example.com/down': { status: 503, text: '' },
  }
  const { clock, calls, fetched } = world(
    on,
    { 'tidbits:prefs': { share: 1 }, 'tidbits:cursor': { changelogAt: NOW }, tidbits: [TIP] },
    {},
    { now: NOW, structured, pages },
  )
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)

  const research = calls.find(c => c.argv.includes('--json-schema'))!
  expect(research.argv[2]).toContain('Today is 2026-10-21')
  expect(research.argv[2]).toContain('published on or after 2026-09-21')
  expect(research.argv[2]).toContain(`- ${TIP.headline}`)
  const argv = research.argv
  expect(argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--permission-mode'))).toEqual(['WebSearch', 'WebFetch'])
  expect(fetched.map(f => f.url)).not.toContain('https://example.com/old')

  // "found" is checked, "down" couldn't be, "missing", "old", "flag" and "dupe" are gone
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /3 tidbits ready/ })).toBeTruthy()
  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const shown: string[] = []
  for (let i = 0; i < 3; i++) {
    shown.push((await ui.find({ type: 'Text', text: /^(Tip \w+|Keep a scratchpad)/ }))!.text!)
    if (await ui.find({ type: 'Text', text: /quote not checked/ })) shown.push('(unchecked)')
    await ui.press({ key: 'next' })
  }
  expect(shown.sort()).toEqual([TIP.headline, '(unchecked)', 'Tip down', 'Tip found'].sort())
  await ui.unmount()
})

test('reactions tune later tidbits, and expired ones are never shown', async ($, on) => {
  const expired = { ...TIP, id: 'research:expired', headline: 'An expired tip.', expiresAt: '2026-10-01T00:00:00.000Z' }
  const { clock, store } = world(
    on,
    { 'tidbits:prefs': { share: 1 }, 'tidbits:cursor': { changelogAt: NOW, researchedAt: NOW }, tidbits: [expired, TIP] },
    {},
    { now: NOW },
  )
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Keep a scratchpad/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /example\.com · 3 days ago/ })).toBeTruthy()

  await ui.press({ key: 'not-useful' })
  expect(await ui.find({ type: 'Text', text: /fewer tidbits on this topic/ })).toBeTruthy()
  expect((store['tidbits:prefs'] as Prefs).weights['context management']).toBe(0.5)

  // Nothing fresh is left, so a seed tidbit comes next
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /An expired tip/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: SEED_TIDBITS[0]!.headline })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Evergreen/ })).toBeTruthy()
  await ui.press({ key: 'knew-it' })
  expect((store['tidbits:prefs'] as Prefs).level).toBe(2.5)

  // Both are kept in the history, newest first, with your reaction
  expect(store['tidbits:history']).toMatchObject([
    { id: SEED_TIDBITS[0]!.id, reaction: 'knew-it' },
    { id: TIP.id, headline: TIP.headline, url: TIP.url, reaction: 'not-useful', shownAt: new Date(NOW).toISOString() },
  ])
  await ui.unmount()
})

test('tidbits stored under the old seen-set name are still known', async ($, on) => {
  const { clock, store } = world(
    on,
    { 'tidbits:prefs': { share: 1 }, 'tidbits:cursor': { changelogAt: NOW, researchedAt: NOW }, 'tidbits:seen': [SEED_TIDBITS[0]!.id] },
    {},
    { now: NOW },
  )
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: SEED_TIDBITS[1]!.headline })).toBeTruthy()
  expect(store['tidbits:known']).toEqual([SEED_TIDBITS[0]!.id, SEED_TIDBITS[1]!.id])
  await ui.unmount()
})

test('you can ask about a tidbit, with the web, and file a bug about it', async ($, on) => {
  const { clock, calls, written, store } = world(
    on,
    {
      'tidbits:prefs': { share: 1 },
      'tidbits:cursor': { changelogAt: NOW, researchedAt: NOW, installed: '2.1.305' },
      tidbits: [TIP],
    },
    {},
    { now: NOW },
  )
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'ask' })
  await ui.input({ key: 'ask', text: 'Does this still work?' })
  await clock.advance(1000)
  expect(store['tidbits:history']).toMatchObject([{ id: TIP.id, isAsked: true }])
  const chat = calls.find(c => c.argv[2]?.includes('"did you know" tip'))!
  expect(chat.argv[2]).toContain('Source: https://example.com/tip (published 2026-10-18)')
  expect(chat.argv[2]).toContain('they run Claude Code 2.1.305')
  expect(chat.argv[2]).toContain('Developer: Does this still work?')
  expect(chat.argv[chat.argv.indexOf('--tools') + 1]).toBe('WebSearch,WebFetch,Read,Grep,Glob')
  expect(chat.argv[chat.argv.indexOf('--model') + 1]).toBe('sonnet')
  expect(await ui.find({ type: 'Markdown', text: /no file to read/ })).toBeTruthy()
  // Asking turns the topic up
  expect((store['tidbits:prefs'] as Prefs).weights['context management']).toBe(1.25)

  await ui.press({ key: 'report' })
  await ui.input({ key: 'issue', text: 'This is out of date' })
  await clock.advance(1000)
  expect(calls.find(c => c.argv[2]?.includes('Rewrite their note'))!.argv[2]).toContain(TIP.headline)
  expect(written[0]!.text).toContain('"did you know" tip from https://example.com/tip')
  await ui.unmount()
})
