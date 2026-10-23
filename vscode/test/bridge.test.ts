import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { parseBridgeLine } from '../src/events'

const SCRIPT = join(__dirname, '../bridge/hooks/forward.sh')
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brain-unrot-bridge-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const forward = (event: string, input: string, env: Record<string, string> = {}) =>
  // A bare environment, as a hook might get: the system's own grep and sed, no shell functions
  execFileSync('/bin/sh', [SCRIPT, event], { input, env: { PATH: '/usr/bin:/bin', HOME: dir, BRAIN_UNROT_DIR: dir, ...env }, encoding: 'utf8' })

const lines = () => {
  try {
    return readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

test('a prompt is forwarded without its text, and prints nothing', () => {
  const out = forward(
    'prompt',
    JSON.stringify({ session_id: 'abc-123', transcript_path: '/x.jsonl', cwd: '/Users/me/my "proj"', hook_event_name: 'UserPromptSubmit', prompt: 'secret "words"' }),
  )
  expect(out).toBe('')
  const [line] = lines()
  expect(line).not.toContain('secret')
  expect(JSON.parse(line!)).toMatchObject({ event: 'prompt', cwd: '/Users/me/my "proj"', session_id: 'abc-123' })
  expect(parseBridgeLine(line!)).toMatchObject({ event: 'prompt', cwd: '/Users/me/my "proj"', source: 'bridge' })
})

test("a Read is forwarded with the file from tool_input, not one in the file's content", () => {
  const input = JSON.stringify(
    {
      session_id: 's',
      cwd: '/Users/me/proj',
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/Users/me/proj/src/a b.ts' },
      tool_response: { file: { filePath: '/Users/me/proj/src/a b.ts', content: 'const x = {"file_path": "nope"}' } },
    },
    null,
    2,
  )
  forward('read', input)
  expect(parseBridgeLine(lines()[0]!)).toMatchObject({ event: 'read', file: '/Users/me/proj/src/a b.ts' })
})

test('a Read without a file, and anything in a child claude, writes nothing', () => {
  forward('read', JSON.stringify({ session_id: 's', cwd: '/p', tool_input: {} }))
  forward('stop', JSON.stringify({ session_id: 's', cwd: '/p' }), { BRAIN_UNROT_CHILD: '1' })
  expect(lines()).toEqual([])
})

test('a slash command is not forwarded', () => {
  forward('prompt', JSON.stringify({ session_id: 's', cwd: '/p', prompt: '/clear' }))
  expect(lines()).toEqual([])
})

test('a stop is forwarded', () => {
  forward('stop', JSON.stringify({ session_id: 's', cwd: '/p', stop_hook_active: false }))
  expect(parseBridgeLine(lines()[0]!)).toMatchObject({ event: 'stop', cwd: '/p' })
})
