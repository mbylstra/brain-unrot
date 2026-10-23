import { expect, test } from 'vitest'

import { NO_IDEA, Quiz, parseQuestions, slug, stepped } from '../src/core/quiz'
import type { Question } from '../src/core/types'
import { MemoryStore, fakeHost, questionsJson } from './fake-host'

// Only the given kind of round, and moving on never stops to ask anything first
async function onlyRounds(global: MemoryStore, category: 'codebase' | 'concept' | 'instructions' | 'tidbit') {
  await global.set('quiz:weights', { codebase: 0, concept: 0, instructions: 0, tidbit: 0, [category]: 1 })
  await global.set('quiz:prefs', { offerChance: 0, preferenceChance: 0 })
}

const question = (prompt: string, extra: Partial<Question> = {}): Question => ({
  id: `${prompt}#1`,
  prompt,
  choices: ['right', 'w1', 'w2', 'w3'],
  answer: 0,
  explanation: '',
  sourceFile: 'src/a.ts',
  difficulty: 1,
  ...extra,
})

const shown = (quiz: Quiz) => {
  const round = quiz.state.round
  if (round?.kind !== 'question') throw new Error('no question shown')
  return round.question
}

test('a file Claude read gets questions written about it, with the code permissions and in the project store', async () => {
  const { host, runs } = fakeHost({ claude: () => questionsJson(['What does `a` do?', 'Why is `b` here?']) })
  const quiz = new Quiz(host)
  quiz.onRead('/repo/src/a.ts')
  await quiz.generate()

  const [run] = runs.filter(r => r.argv[1] === '-p')
  expect(run!.argv[2]).toContain('Read src/a.ts and write 2 multiple-choice questions')
  expect(run!.cwd).toBe('/repo')
  expect(run!.env).toEqual({ BRAIN_UNROT_CHILD: '1' })
  const flag = (name: string) => run!.argv[run!.argv.indexOf(name) + 1]
  expect(flag('--tools')).toBe('Read,Grep,Glob,Bash')
  expect(flag('--permission-mode')).toBe('dontAsk')
  expect(run!.argv).toContain('--strict-mcp-config')
  expect(run!.argv).toContain('--no-session-persistence')

  const queue = (await host.project.get('queue')) as Question[]
  expect(queue.map(q => [q.prompt, q.sourceFile])).toEqual([
    ['What does `a` do?', 'src/a.ts'],
    ['Why is `b` here?', 'src/a.ts'],
  ])
  expect(await host.global.get('concepts')).toEqual([])
  expect(quiz.state.ready).toBe(2)
})

test('concept questions are kept globally, tagged with their project, and any project can use them', async () => {
  const global = new MemoryStore()
  // Enough codebase questions that the next top-up is a concept one
  const a = fakeHost({ root: '/a', global, claude: () => questionsJson(['When would you use a queue?']) })
  await a.host.project.set('queue', [1, 2, 3, 4, 5].map(n => question(`code ${n}`)))
  await new Quiz(a.host).generate()

  const concepts = (await global.get('concepts')) as Question[]
  expect(concepts).toHaveLength(1)
  expect(concepts[0]).toMatchObject({ category: 'concept', project: '/a', sourceFile: undefined })
  expect(a.runs.find(r => r.argv[1] === '-p')!.argv).toContain('sonnet')

  const b = fakeHost({ root: '/b', global })
  await onlyRounds(global, 'concept')
  const quiz = new Quiz(b.host)
  await quiz.newRound()
  expect(shown(quiz).prompt).toBe('When would you use a queue?')

  // Answered right: remembered globally, not in project b
  await quiz.act({ type: 'choose', index: shown(quiz).answer })
  expect(await global.get('answered')).toEqual(['When would you use a queue?'])
  expect(await b.host.project.get('answered')).toBeUndefined()
})

test('a wrong answer sends the question to the back of the queue; a right one is never asked again', async () => {
  const { host } = fakeHost()
  await onlyRounds(host.global as MemoryStore, 'codebase')
  await host.project.set('queue', [question('first'), question('second')])
  const quiz = new Quiz(host)

  await quiz.newRound()
  expect(shown(quiz).prompt).toBe('first')
  await quiz.act({ type: 'choose', index: (shown(quiz).answer + 1) % 4 })
  expect(((await host.project.get('queue')) as Question[]).map(q => q.prompt)).toEqual(['second', 'first'])

  await quiz.act({ type: 'next' })
  expect(shown(quiz).prompt).toBe('second')
  await quiz.act({ type: 'choose', index: shown(quiz).answer })
  expect(await host.project.get('answered')).toEqual(['second'])
})

test('skill: three right in a row moves the difficulty up; a wrong answer or no idea steps down', () => {
  let s = { difficulty: 1, streak: 0 }
  s = stepped(stepped(stepped(s, 'right'), 'right'), 'right')
  expect(s).toEqual({ difficulty: 2, streak: 0 })
  expect(stepped(s, 'wrong')).toEqual({ difficulty: 1.5, streak: 0 })
  expect(stepped(s, 'no-idea')).toEqual({ difficulty: 1, streak: 0 })
  expect(stepped(s, 'helped')).toBe(s)
})

test('with nothing generated, a seed question is shown', async () => {
  const { host } = fakeHost()
  await onlyRounds(host.global as MemoryStore, 'codebase')
  const quiz = new Quiz(host)
  await quiz.onPrompt()
  expect(shown(quiz).id).toMatch(/^seed-/)
  // Seeds are general, so knowing one is remembered globally
  await quiz.act({ type: 'choose', index: NO_IDEA })
  expect(quiz.state.skill.difficulty).toBe(1)
  await quiz.act({ type: 'skip' })
  expect(((await host.global.get('answered')) as string[]).length).toBe(1)
})

test('once Claude finishes, the round you are on carries on, and the next one says Claude is ready', async () => {
  const { host } = fakeHost()
  await onlyRounds(host.global as MemoryStore, 'codebase')
  await host.project.set('queue', [question('first'), question('second'), question('third')])
  const quiz = new Quiz(host)
  await quiz.onPrompt()
  const first = shown(quiz)

  await quiz.onStop()
  expect(quiz.state.isClaudeReady).toBe(false)
  expect(shown(quiz)).toBe(first)
  expect((await quiz.view()).isClaudeFinished).toBe(true)

  await quiz.act({ type: 'choose', index: first.answer })
  await quiz.act({ type: 'next' })
  expect(quiz.state.isClaudeReady).toBe(true)
  expect(shown(quiz)).toBe(first)

  await quiz.act({ type: 'keepGoing' })
  expect(quiz.state.isClaudeReady).toBe(false)
  expect(shown(quiz).prompt).toBe('second')

  // The next prompt clears it too
  await quiz.onStop()
  await quiz.act({ type: 'skip' })
  expect(quiz.state.isClaudeReady).toBe(true)
  await quiz.onPrompt()
  expect(quiz.state.isClaudeReady).toBe(false)
  expect(shown(quiz).prompt).toBe('third')
})

test('a clarifying question gets a reply, and asking first means a right answer does not move the difficulty', async () => {
  const { host, runs } = fakeHost({ claude: () => 'It means the function that runs first.' })
  await onlyRounds(host.global as MemoryStore, 'codebase')
  await host.project.set('queue', [question('first')])
  const quiz = new Quiz(host)
  await quiz.newRound()

  await quiz.act({ type: 'ask' })
  await quiz.act({ type: 'send', text: '  what is "first"?  ' })
  expect(quiz.state.round?.isThinking).toBe(true)
  await quiz.discuss()
  expect(quiz.state.round?.chat).toEqual([
    { from: 'you', text: 'what is "first"?' },
    { from: 'claude', text: 'It means the function that runs first.' },
  ])
  const prompt = runs.find(r => r.argv[1] === '-p')!.argv[2]!
  expect(prompt).toContain('Never reveal it')
  // The chat may edit files: Edit and Write, limited to the repo
  expect(runs[0]!.argv).toContain('Edit(./**)')

  await quiz.act({ type: 'choose', index: shown(quiz).answer })
  expect(quiz.state.skill).toEqual({ difficulty: 1, streak: 0 })
})

test('an issue is rephrased and filed under docs/issues/todo; without a rephrasing it is filed as written', async () => {
  let reply = JSON.stringify({ title: 'Clarify what `a` returns', body: 'The question is ambiguous.' })
  const { host, files } = fakeHost({ claude: () => reply })
  await onlyRounds(host.global as MemoryStore, 'codebase')
  await host.project.set('queue', [question('first'), question('second')])
  const quiz = new Quiz(host)
  await quiz.newRound()

  await quiz.act({ type: 'report' })
  expect(quiz.state.round?.issue).toBe(true)
  await quiz.act({ type: 'submitIssue', text: 'this is confusing' })
  expect(quiz.state.round?.issue).toBeUndefined()
  expect(quiz.state.notice).toBe('Filing the issue…')
  await quiz.fileIssue()
  const path = '/repo/docs/issues/todo/2026-10-23-clarify-what-a-returns.md'
  expect(files.get(path)).toContain('# Clarify what `a` returns')
  expect(files.get(path)).toContain('> this is confusing')
  expect(quiz.state.notice).toBe('Filed docs/issues/todo/2026-10-23-clarify-what-a-returns.md')

  reply = 'not json'
  await quiz.act({ type: 'report' })
  await quiz.act({ type: 'submitIssue', text: 'Clarify what a returns\nmore detail' })
  await quiz.fileIssue()
  expect(files.has('/repo/docs/issues/todo/2026-10-23-clarify-what-a-returns-2.md')).toBe(true)
})

test('instruction questions are written when the project has instruction files', async () => {
  const { host, runs } = fakeHost({
    files: { '/repo/CLAUDE.md': '# Rules', '/repo/.claude/skills/frontend/SKILL.md': '# Frontend' },
    claude: () => questionsJson(['Which skill covers the frontend?']),
  })
  await host.project.set('queue', [1, 2, 3, 4, 5].map(n => question(`code ${n}`)))
  await host.global.set('concepts', [1, 2].map(n => question(`concept ${n}`, { category: 'concept', sourceFile: undefined })))
  const quiz = new Quiz(host)
  await quiz.generate()

  const prompt = runs.find(r => r.argv[1] === '-p')!.argv
  expect(prompt[2]).toContain('- CLAUDE.md\n- .claude/skills/frontend/SKILL.md')
  // No Bash for instruction questions
  expect(prompt[prompt.indexOf('--tools') + 1]).toBe('Read,Grep,Glob')
  const queue = (await host.project.get('queue')) as Question[]
  expect(queue[0]).toMatchObject({ prompt: 'Which skill covers the frontend?', category: 'instructions' })
})

test('saying yes to more about a file puts its questions first', async () => {
  const { host } = fakeHost()
  await host.global.set('quiz:weights', { codebase: 1, concept: 0, instructions: 0, tidbit: 0 })
  await host.global.set('quiz:prefs', { offerChance: 1, preferenceChance: 0 })
  await host.project.set('queue', [question('about a'), question('about b', { sourceFile: 'src/b.ts' }), question('more about a'), question('again about a')])
  const quiz = new Quiz(host)
  await quiz.newRound()
  expect(shown(quiz).prompt).toBe('about a')

  await quiz.act({ type: 'skip' })
  expect(quiz.state.round).toMatchObject({ kind: 'question', isOffering: true })
  await quiz.act({ type: 'moreAboutFile', isYes: true })
  expect(shown(quiz).prompt).toBe('more about a')
})

test('parsers', () => {
  expect(parseQuestions('Here: ' + questionsJson(['q'], 'x.ts') + ' done', 3)).toMatchObject([{ prompt: 'q', sourceFile: 'x.ts', difficulty: 3 }])
  // Duplicate choices are dropped
  expect(parseQuestions(JSON.stringify([{ prompt: 'q', choices: ['a', 'a', 'b', 'c'], answer: 0 }]), 1)).toEqual([])
  expect(slug('  Fix: the `queue` (again)!  ')).toBe('fix-the-queue-again')
})
