import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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
    file: 'src/config.ts',
  },
  { prompt: 'Broken question', choices: ['only two', 'choices'], answer: 0 },
])

const CHAT_REPLY = 'It asks what the function hands back when there is no file to read.'

const ISSUE_REPLY = JSON.stringify({
  title: 'Rename `x` in loadConfig/to something clearer',
  body: 'In `src/config.ts`, `loadConfig` names its result `x`. Call it `config`.',
})

const FILLER = { prompt: 'Filler?', choices: ['a', 'b', 'c', 'd'], answer: 0, explanation: '', file: 'x.ts' }

// Stands in for the engine; returns the argv of each claude CLI call
function world(on: On, store: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const opened: string[] = []
  const clock = mock.clock(on)
  mock.store(on, store)
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
  const calls: { argv: readonly string[]; env?: Readonly<Record<string, string>> }[] = []
  on('process.run', (_, e) => {
    calls.push({ argv: e.argv, env: e.init?.env })
    const prompt = e.argv[2] ?? ''
    const stdout = prompt.includes('clarifying question')
      ? CHAT_REPLY
      : prompt.includes('Rewrite their note')
        ? ISSUE_REPLY
        : REPLY
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { clock, calls, opened, written }
}

test('a warm-up question shows at once, and the pantry fills with repo questions', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Warm-up question/ })).toBeTruthy()

  // The pantry is low, so the next tick asks claude about the repo as a whole
  await clock.advance(3000)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.argv.slice(0, 2)).toEqual(['claude', '-p'])
  expect(calls[0]!.argv[2]).toContain('Look around the repository')
  expect(calls[0]!.env).toEqual({ BRAIN_UNROT_CHILD: '1' })
  expect(await ui.find({ type: 'Text', text: /1 generated questions ready/ })).toBeTruthy()

  await ui.press({ key: 'choice-0' })
  expect(await ui.find({ type: 'Text', text: /Correct!|Wrong/ })).toBeTruthy()
  await ui.press({ key: 'next' })

  expect(await ui.find({ type: 'Text', text: /From src\/config\.ts/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /loadConfig/ })).toBeTruthy()
  await ui.unmount()
})

test('a file Claude reads becomes questions, even with a full pantry', async ($, on) => {
  const pantry = Array.from({ length: 5 }, (_, i) => ({ ...FILLER, id: `filler-${i}` }))
  const { clock, calls } = world(on, { 'pantry:/repo': pantry })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await clock.advance(3000)
  expect(calls).toHaveLength(0)

  await $.tool.call({ tool: 'Read', file_path: '/repo/src/config.ts' })
  await clock.advance(3000)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.argv[2]).toContain('Read src/config.ts')
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

test('"Absolutely no idea" reveals the answer and steps the level down', async ($, on) => {
  const { clock, calls } = world(on, { 'skill:/repo': { level: 3, streak: 2 } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Level 3 of 5/ })).toBeTruthy()

  await ui.press({ key: 'no-idea' })
  expect(await ui.find({ type: 'Text', text: /No worries — it was/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Level 2 of 5/ })).toBeTruthy()

  // The next questions are asked for at the new level
  await clock.advance(3000)
  expect(calls[0]!.argv[2]).toContain('level 2 of 5')
  await ui.unmount()
})

test('a clarifying question opens a discussion, and you can then answer or skip', async ($, on) => {
  const known = { ...FILLER, id: 'known', choices: ['right one', 'b', 'c', 'd'], level: 1 }
  const { clock, calls } = world(on, { 'skill:/repo': { level: 2, streak: 2 }, 'pantry:/repo': [known] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'ask' })
  await ui.input({ key: 'ask', text: 'What does', kind: 'change' })
  expect((await ui.find({ type: 'Input', key: 'ask' }))?.text).toBe('What does')
  await ui.input({ key: 'ask', text: 'What does "missing" mean here?' })
  expect((await ui.find({ type: 'Input', key: 'ask' }))?.text).toBe('')
  expect(await ui.find({ type: 'Text', text: /You: What does "missing" mean here\?/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Claude is thinking/ })).toBeTruthy()

  // The chat timer asks claude, with the question and the discussion so far
  await clock.advance(1000)
  const chat = calls.find(c => c.argv[2]?.includes('clarifying question'))!
  expect(chat.argv[2]).toContain('Never reveal it')
  expect(chat.argv[2]).toContain('Developer: What does "missing" mean here?')
  expect(await ui.find({ type: 'Markdown', text: /no file to read/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Claude is thinking/ })).toBeFalsy()

  // Answering after a discussion reveals the answer; a right one doesn't move the level
  const right = await ui.find({ type: 'Button', text: /right one/ })
  await ui.press({ key: right!.key! })
  expect(await ui.find({ type: 'Text', text: /Correct!/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Level 2 of 5/ })).toBeTruthy()
  await ui.press({ key: 'next' })

  // Skipping moves straight on to the next question, level unchanged
  await ui.press({ key: 'ask' })
  expect(await ui.find({ key: 'skip' })).toBeTruthy()
  await ui.press({ key: 'skip' })
  expect(await ui.find({ key: 'skip' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'ask', text: /Ask a clarifying question/ })).toBeTruthy()
  await ui.unmount()
})

test('an issue you describe is rephrased and written to docs/issues/todo', async ($, on) => {
  const known = { ...FILLER, id: 'known', prompt: 'What is `x` in loadConfig?', file: 'src/config.ts', level: 1 }
  const { clock, calls, written } = world(on, { 'skill:/repo': { level: 2, streak: 2 }, 'pantry:/repo': [known] })
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
  const levelBefore = (await ui.find({ type: 'Text', text: /Level \d of 5/ }))?.text
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

  // Filing doesn't move the level, and a second issue with the same title gets its own file
  expect((await ui.find({ type: 'Text', text: /Level \d of 5/ }))?.text).toBe(levelBefore)
  await ui.press({ key: 'report' })
  await ui.input({ key: 'issue', text: 'still a terrible name' })
  await clock.advance(1000)
  expect(written).toHaveLength(2)
  expect(written[1]!.path).toMatch(/clearer-2\.md$/)
  await ui.unmount()
})
