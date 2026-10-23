import { open, readdir, stat, truncate } from 'node:fs/promises'
import { join } from 'node:path'

// What Claude did, from the bridge plugin or from a session transcript
export type ClaudeEvent = {
  event: 'prompt' | 'read' | 'stop'
  cwd: string
  sessionId?: string
  // The file Claude read (read events only)
  file?: string
  source: 'bridge' | 'transcript'
  // When it happened, in ms, if the transcript entry says
  at?: number
}

const EVENTS: ClaudeEvent['event'][] = ['prompt', 'read', 'stop']

// A line the bridge appended: { event, cwd, session_id, file?, at }
export function parseBridgeLine(line: string): ClaudeEvent | undefined {
  try {
    const raw = JSON.parse(line)
    if (!EVENTS.includes(raw?.event) || typeof raw.cwd !== 'string' || raw.cwd === '') return undefined
    if (raw.event === 'read' && (typeof raw.file !== 'string' || raw.file === '')) return undefined
    return {
      event: raw.event,
      cwd: raw.cwd,
      sessionId: typeof raw.session_id === 'string' ? raw.session_id : undefined,
      file: raw.event === 'read' ? raw.file : undefined,
      source: 'bridge',
    }
  } catch {
    return undefined
  }
}

// Claude Code's own transcript format is internal and undocumented, so this is defensive:
// a `user` entry with text is a prompt (not a tool result, a slash command or Claude Code's own
// meta text), an `assistant` `tool_use` of Read is a file read, and a `system` `turn_duration`
// entry is the end of Claude's turn. Subagent (sidechain) entries are left out. `undefined` means
// the line wasn't understood; an empty list means it was, and it isn't one of these
export function parseTranscriptLine(line: string): ClaudeEvent[] | undefined {
  let raw: any
  try {
    raw = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof raw?.type !== 'string') return undefined
  if (raw.isSidechain || raw.isMeta || raw.isCompactSummary) return []
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : undefined
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : undefined
  const time = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN
  const at = (event: ClaudeEvent['event'], file?: string): ClaudeEvent => ({
    event,
    cwd: cwd!,
    sessionId,
    file,
    source: 'transcript',
    ...(Number.isFinite(time) ? { at: time } : {}),
  })
  if (raw.type === 'system') return raw.subtype === 'turn_duration' && cwd ? [at('stop')] : []
  if (raw.type !== 'user' && raw.type !== 'assistant') return []
  const content = raw.message?.content
  if (!cwd || content === undefined) return undefined
  if (raw.type === 'user') {
    const texts: string[] =
      typeof content === 'string'
        ? [content]
        : Array.isArray(content) && !content.some(c => c?.type === 'tool_result')
          ? content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text)
          : []
    const text = texts.join('\n').trim()
    // Slash commands and their output are wrapped in <command-…> and <local-command-…> tags
    const isPrompt = text !== '' && !text.startsWith('<') && !text.startsWith('[Request interrupted')
    return isPrompt ? [at('prompt')] : []
  }
  if (!Array.isArray(content)) return []
  return content.filter(c => c?.type === 'tool_use' && c.name === 'Read' && typeof c.input?.file_path === 'string').map(c => at('read', c.input.file_path))
}

// Reads the lines appended to a file since the last call. A file that shrank (another window
// truncated it) is read again from the start
export class Tail {
  private buffer = ''

  constructor(
    readonly path: string,
    private offset: number,
  ) {}

  async lines(): Promise<string[]> {
    let size: number
    try {
      size = (await stat(this.path)).size
    } catch {
      return []
    }
    if (size < this.offset) {
      this.offset = 0
      this.buffer = ''
    }
    if (size === this.offset) return []
    const file = await open(this.path, 'r')
    try {
      const length = size - this.offset
      const chunk = Buffer.alloc(length)
      const { bytesRead } = await file.read(chunk, 0, length, this.offset)
      this.offset += bytesRead
      this.buffer += chunk.subarray(0, bytesRead).toString('utf8')
    } finally {
      await file.close()
    }
    const parts = this.buffer.split('\n')
    this.buffer = parts.pop() ?? ''
    return parts.filter(line => line.trim() !== '')
  }
}

const POLL_MS = 500
// How often to look for transcripts, and how recently one must have changed to be watched
const SCAN_MS = 3000
const ACTIVE_MS = 10 * 60_000
// The bridge's file is emptied when it grows past this
const EVENTS_MAX_BYTES = 1_000_000
// Once the bridge has been heard from, transcript events are ignored for this long
const BRIDGE_WINS_MS = 30 * 60_000

// Watches ~/.brain-unrot/events.jsonl (the bridge) and, as a fallback, Claude Code's transcripts
// in ~/.claude/projects/*/*.jsonl. Polling `stat` is simpler and steadier than fs.watch on macOS
export class EventWatcher {
  private bridge: Tail | undefined
  private readonly transcripts = new Map<string, Tail>()
  // Every transcript seen, watched or not, and its size when last looked at
  private readonly sizes = new Map<string, number>()
  private readonly startedAt = Date.now()
  private lastBridgeAt = -Infinity
  private lastScanAt = -Infinity
  private timer: NodeJS.Timeout | undefined
  private isPolling = false

  constructor(
    private readonly eventsPath: string,
    private readonly projectsDir: string,
    private readonly onEvent: (e: ClaudeEvent) => void,
    private readonly log: (line: string) => void,
  ) {}

  async start() {
    // Old events are of no use: start empty
    await truncate(this.eventsPath, 0).catch(() => undefined)
    this.bridge = new Tail(this.eventsPath, 0)
    this.timer = setInterval(() => void this.poll(), POLL_MS)
  }

  stop() {
    clearInterval(this.timer)
  }

  private async poll() {
    if (this.isPolling) return
    this.isPolling = true
    try {
      await this.pollBridge()
      if (Date.now() - this.lastScanAt >= SCAN_MS) await this.scan()
      for (const tail of this.transcripts.values()) {
        for (const line of await tail.lines()) {
          const events = parseTranscriptLine(line)
          if (events === undefined) {
            this.log(`transcript: unexpected line in ${tail.path}: ${line.slice(0, 120)}`)
            continue
          }
          if (Date.now() - this.lastBridgeAt < BRIDGE_WINS_MS) continue
          // A resumed session can start a new file with the old history in it: don't replay that
          events.filter(e => e.at === undefined || e.at >= this.startedAt).forEach(this.onEvent)
        }
      }
    } catch (err) {
      this.log(`events: ${String(err)}`)
    } finally {
      this.isPolling = false
    }
  }

  private async pollBridge() {
    if (!this.bridge) return
    for (const line of await this.bridge.lines()) {
      const e = parseBridgeLine(line)
      if (!e) {
        this.log(`bridge: unexpected line ${line.slice(0, 120)}`)
        continue
      }
      this.lastBridgeAt = Date.now()
      this.onEvent(e)
    }
    const size = (await stat(this.eventsPath).catch(() => undefined))?.size ?? 0
    if (size > EVENTS_MAX_BYTES) await truncate(this.eventsPath, 0).catch(() => undefined)
  }

  // Transcripts changed in the last few minutes are watched. One seen before (say, a session idle
  // since the window opened) is read from where it ended then, so the prompt that woke it isn't
  // missed. One never seen is read whole if it's new since this window started, else from its end
  private async scan() {
    this.lastScanAt = Date.now()
    const dirs = await readdir(this.projectsDir, { withFileTypes: true }).catch(() => [])
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const files = await readdir(join(this.projectsDir, dir.name)).catch(() => [])
      for (const name of files) {
        if (!name.endsWith('.jsonl')) continue
        const path = join(this.projectsDir, dir.name, name)
        const info = await stat(path).catch(() => undefined)
        if (!info) continue
        const seen = this.sizes.get(path)
        this.sizes.set(path, info.size)
        if (this.transcripts.has(path) || Date.now() - info.mtimeMs > ACTIVE_MS) continue
        const from = seen ?? (info.birthtimeMs >= this.startedAt ? 0 : info.size)
        this.transcripts.set(path, new Tail(path, from))
      }
    }
    // Forget transcripts that went quiet
    for (const [path, _] of this.transcripts) {
      const info = await stat(path).catch(() => undefined)
      if (!info || Date.now() - info.mtimeMs > ACTIVE_MS) this.transcripts.delete(path)
    }
  }
}

// Whether a path is the folder or inside it
export const isInside = (folder: string, path: string) => path === folder || path.startsWith(folder.endsWith('/') ? folder : folder + '/')
