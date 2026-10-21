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
  on('fs.write', () => ({ value: undefined }))
  const calls: { argv: readonly string[]; env?: Readonly<Record<string, string>> }[] = []
  on('process.run', (_, e) => {
    calls.push({ argv: e.argv, env: e.init?.env })
    return { value: { exitCode: 0, stdout: REPLY, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { clock, calls, opened }
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
