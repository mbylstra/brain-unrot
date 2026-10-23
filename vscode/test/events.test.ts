import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { EventWatcher, Tail, isInside, parseBridgeLine, parseTranscriptLine } from '../src/events'
import { JsonStore, projectStore } from '../src/store'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brain-unrot-events-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const line = (entry: object) => JSON.stringify({ cwd: '/repo', sessionId: 's1', ...entry })

test('transcript: prompts, Read calls and turn ends are found', () => {
  expect(parseTranscriptLine(line({ type: 'user', message: { role: 'user', content: 'fix the bug' } }))).toEqual([
    { event: 'prompt', cwd: '/repo', sessionId: 's1', file: undefined, source: 'transcript' },
  ])
  expect(parseTranscriptLine(line({ type: 'user', message: { content: [{ type: 'image' }, { type: 'text', text: 'what is this?' }] } }))?.[0]?.event).toBe('prompt')
  expect(
    parseTranscriptLine(
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Reading.' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/repo/a.ts' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    ),
  ).toMatchObject([{ event: 'read', file: '/repo/a.ts' }])
  expect(parseTranscriptLine(line({ type: 'system', subtype: 'turn_duration' }))).toMatchObject([{ event: 'stop' }])
})

test('transcript: tool results, slash commands, meta text and subagents are not prompts', () => {
  const none = [
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    line({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
    line({ type: 'user', isMeta: true, message: { content: 'Caveat: …' } }),
    line({ type: 'user', isSidechain: true, message: { content: 'subagent task' } }),
    line({ type: 'user', message: { content: '[Request interrupted by user]' } }),
    line({ type: 'system', subtype: 'stop_hook_summary' }),
    line({ type: 'file-history-snapshot' }),
  ]
  for (const l of none) expect(parseTranscriptLine(l)).toEqual([])
  expect(parseTranscriptLine('not json')).toBeUndefined()
  expect(parseTranscriptLine(JSON.stringify({ type: 'user' }))).toBeUndefined()
})

test('bridge lines', () => {
  expect(parseBridgeLine('{"event":"read","cwd":"/repo","session_id":"s","file":"/repo/a.ts","at":1}')).toEqual({
    event: 'read',
    cwd: '/repo',
    sessionId: 's',
    file: '/repo/a.ts',
    source: 'bridge',
  })
  expect(parseBridgeLine('{"event":"read","cwd":"/repo"}')).toBeUndefined()
  expect(parseBridgeLine('{"event":"other","cwd":"/repo"}')).toBeUndefined()
})

test('tail: reads appended lines, waits for a partial one, and starts over when the file shrinks', async () => {
  const path = join(dir, 'events.jsonl')
  writeFileSync(path, 'old\n')
  const tail = new Tail(path, 4)
  expect(await tail.lines()).toEqual([])
  appendFileSync(path, 'one\ntw')
  expect(await tail.lines()).toEqual(['one'])
  appendFileSync(path, 'o\n')
  expect(await tail.lines()).toEqual(['two'])
  truncateSync(path, 0)
  appendFileSync(path, 'new\n')
  expect(await tail.lines()).toEqual(['new'])
})

test('isInside', () => {
  expect(isInside('/repo', '/repo')).toBe(true)
  expect(isInside('/repo', '/repo/src/a.ts')).toBe(true)
  expect(isInside('/repo', '/repository/a.ts')).toBe(false)
})

test('watcher: a transcript idle since the window opened still gives the prompt that wakes it', { timeout: 10_000 }, async () => {
  const projects = join(dir, 'projects')
  mkdirSync(join(projects, '-repo'), { recursive: true })
  const transcript = join(projects, '-repo', 'session.jsonl')
  writeFileSync(transcript, line({ type: 'user', message: { content: 'an old prompt' }, timestamp: '2026-01-01T00:00:00Z' }) + '\n')
  const anHourAgo = Date.now() / 1000 - 3600
  utimesSync(transcript, anHourAgo, anHourAgo)

  const seen: string[] = []
  const watcher = new EventWatcher(join(dir, 'events.jsonl'), projects, e => seen.push(e.event), () => undefined)
  await watcher.start()
  try {
    await new Promise(r => setTimeout(r, 700))
    appendFileSync(transcript, line({ type: 'user', message: { content: 'a new prompt' }, timestamp: new Date().toISOString() }) + '\n')
    await new Promise(r => setTimeout(r, 4000))
  } finally {
    watcher.stop()
  }
  expect(seen).toEqual(['prompt'])
})

test('store: one JSON file per key, and a .gitignore in the project folder', async () => {
  const global = new JsonStore(join(dir, 'global'))
  expect(await global.get('quiz:prefs')).toBeUndefined()
  await global.set('quiz:prefs', { offerChance: 0 })
  expect(JSON.parse(readFileSync(join(dir, 'global', 'quiz-prefs.json'), 'utf8'))).toEqual({ offerChance: 0 })
  expect(await global.get('quiz:prefs')).toEqual({ offerChance: 0 })

  const project = projectStore(join(dir, 'repo'))
  await project.set('queue', [])
  expect(readFileSync(join(dir, 'repo', '.brain-unrot', '.gitignore'), 'utf8')).toBe('*\n')
})
