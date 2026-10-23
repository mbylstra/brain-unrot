// Ported from plugin/hooks/tidbits.ts. Everything here is general, so it's kept in the global store
import type { Host } from '../host'

import type { Message, Prefs, Reaction, ShownTidbit, Tidbit, Topic } from './types'
import { askClaude, random } from './claude'
import { SEED_TIDBITS } from './seeds'

// Sonnet for everything tidbit-related: Haiku took the first search result at face value
export const TIDBIT_MODEL = 'sonnet'
export const CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md'
const CHANGELOG_PAGE = 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md'
export const RELEASES_URL = 'https://api.github.com/repos/anthropics/claude-code/releases?per_page=100'
const DAY = 86_400_000
// How often each lane runs
const REFRESH_MS = DAY
// With fewer than this many tidbits ready, research runs every LOW_REFRESH_MS instead
const LOW_COUNT = 5
const LOW_REFRESH_MS = 60 * 60_000
// A failed run tries again after this long
const RETRY_MS = 30 * 60_000
const TIDBITS_MAX = 40
const KNOWN_MAX = 1000
const HISTORY_MAX = 500
const FEATURE_TTL = 42 * DAY
const TECHNIQUE_TTL = 84 * DAY
// Releases older than this aren't turned into tidbits
const RELEASE_AGE_MAX = 60 * DAY
// At most this many releases go into one digest
const RELEASES_MAX = 8
// Research asks for items published this recently
const WINDOW = 30 * DAY
// Guards against a runaway call, in USD; there's no daily cap
const BUDGET = { changelog: 1, research: 3, chat: 1 }
const LEVEL_MIN = 1
const LEVEL_MAX = 5
const WEIGHT_MIN = 0.1
const WEIGHT_MAX = 4
// A page with less text than this was likely drawn by JavaScript: it can't confirm or refute a quote
const PAGE_MIN = 500

export const TOPICS: Topic[] = [
  'context management',
  'prompting',
  'agents and subagents',
  'testing and verification',
  'cost and model choice',
  'security',
  'IDE and CLI workflow',
]

const LEVELS: Record<number, string> = {
  1: 'new to coding with LLMs: explain the idea from scratch',
  2: 'a beginner: knows the basics, not the features',
  3: 'a regular user: skip the basics',
  4: 'experienced: only things a regular user would likely not know',
  5: 'an expert: only new or little-known things',
}

// Stored globally, since this knowledge isn't per repo
const KEY = { tidbits: 'tidbits', known: 'tidbits:known', cursor: 'tidbits:cursor', prefs: 'tidbits:prefs', history: 'tidbits:history' }

// `version` and `etag` are where the CHANGELOG was last read up to; `changelogAt` and
// `researchedAt` when each lane last ran. `firstSeen` dates releases the releases API doesn't list
type Cursor = {
  version?: string
  etag?: string
  changelogAt?: number
  researchedAt?: number
  installed?: string
  lastTopic?: Topic
  firstSeen?: Record<string, string>
}

const said = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ')
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

// FNV-1a: keeps the known-set small
const hash = (text: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16)
}

// --- Store ---

async function loadCursor(host: Host): Promise<Cursor> {
  const stored = await host.global.get(KEY.cursor)
  return stored && typeof stored === 'object' ? (stored as Cursor) : {}
}

async function saveCursor(host: Host, change: Partial<Cursor>) {
  await host.global.set(KEY.cursor, { ...(await loadCursor(host)), ...change })
}

export async function loadPrefs(host: Host): Promise<Prefs> {
  const stored = (await host.global.get(KEY.prefs)) as Partial<Prefs> | undefined
  return { level: stored?.level ?? 2, weights: stored?.weights ?? {} }
}

// Hashes of every tidbit ever queued, and the ids of seed tidbits shown, so none comes round twice.
// It was stored as `tidbits:seen` before the rename
async function loadKnown(host: Host): Promise<string[]> {
  const stored = (await host.global.get(KEY.known)) ?? (await host.global.get('tidbits:seen'))
  return Array.isArray(stored) ? (stored as string[]) : []
}

async function loadTidbits(host: Host): Promise<Tidbit[]> {
  const stored = await host.global.get(KEY.tidbits)
  return Array.isArray(stored) ? (stored as Tidbit[]) : []
}

// One write at a time: research and the pane both change the queue and the known-set
let lock: Promise<unknown> = Promise.resolve()
function withTidbits<T>(
  host: Host,
  fn: (tidbits: Tidbit[], known: string[]) => Promise<[Tidbit[], string[], T]>,
): Promise<T> {
  const run = lock.then(async () => {
    const [tidbits, known, result] = await fn(await loadTidbits(host), await loadKnown(host))
    await host.global.set(KEY.tidbits, tidbits.slice(0, TIDBITS_MAX))
    await host.global.set(KEY.known, known.slice(-KNOWN_MAX))
    return result
  })
  lock = run.catch(() => undefined)
  return run
}

export async function loadHistory(host: Host): Promise<ShownTidbit[]> {
  const stored = await host.global.get(KEY.history)
  return Array.isArray(stored) ? (stored as ShownTidbit[]) : []
}

// Every tidbit shown, newest first, so they can be read again after they leave the queue
function withHistory(host: Host, fn: (history: ShownTidbit[]) => ShownTidbit[]): Promise<void> {
  const run = lock.then(async () => {
    await host.global.set(KEY.history, fn(await loadHistory(host)).slice(0, HISTORY_MAX))
  })
  lock = run.catch(() => undefined)
  return run
}

// A tidbit is known by its headline, and by its page (or its CHANGELOG line, since
// every changelog tidbit shares the one page)
const keysOf = (t: Tidbit) =>
  t.lane === 'seed' ? [t.id] : [hash(`h:${said(t.headline)}`), hash(t.lane === 'changelog' ? `q:${said(t.quote)}` : `u:${t.url}`)]

export async function addTidbits(host: Host, found: Tidbit[]): Promise<Tidbit[]> {
  return withTidbits(host, async (tidbits, known) => {
    const taken = new Set([...known, ...tidbits.flatMap(keysOf)])
    const added = found.filter(t => {
      const keys = keysOf(t)
      if (keys.some(k => taken.has(k))) return false
      keys.forEach(k => taken.add(k))
      return true
    })
    return [[...added, ...tidbits], [...known, ...added.flatMap(keysOf)], added]
  })
}

const isExpired = (t: Tidbit, now: number) => t.expiresAt !== undefined && Date.parse(t.expiresAt) <= now

export async function tidbitsReady(host: Host): Promise<number> {
  const now = host.now()
  return (await loadTidbits(host)).filter(t => !isExpired(t, now)).length
}

const weightOf = (p: Prefs, topic: Topic) => p.weights[topic] ?? 1

// The best tidbit ready: newer ones first, scaled by how much you like the topic.
// Expired ones are dropped; with nothing ready, a seed tidbit not yet shown
export async function nextTidbit(host: Host): Promise<Tidbit | undefined> {
  const now = host.now()
  const prefs = await loadPrefs(host)
  const score = (t: Tidbit) => {
    const age = (now - Date.parse(t.publishedAt ?? '')) / DAY
    return weightOf(prefs, t.topic) / (1 + (Number.isFinite(age) ? Math.max(0, age) : 30) / 14)
  }
  const shown = await withTidbits(host, async (all, known) => {
    const tidbits = all.filter(t => !isExpired(t, now))
    const best = tidbits.reduce<Tidbit | undefined>((b, t) => (!b || score(t) > score(b) ? t : b), undefined)
    if (best) return [tidbits.filter(t => t !== best), known, best]
    const seed = SEED_TIDBITS.find(t => !known.includes(t.id))
    return [tidbits, seed ? [...known, seed.id] : known, seed]
  })
  if (shown) await withHistory(host, history => [{ ...shown, shownAt: new Date(now).toISOString() }, ...history])
  return shown
}

// "Knew it" and "New to me" tune how advanced tidbits are; "Not useful" turns the topic
// down, and asking about a tidbit turns it up
export function reacted(p: Prefs, topic: Topic, reaction: Reaction | 'asked'): Prefs {
  const level = (n: number) => Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, n))
  const weight = (n: number) => ({ ...p.weights, [topic]: Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, n)) })
  if (reaction === 'knew-it') return { ...p, level: level(p.level + 0.5) }
  if (reaction === 'new-to-me') return { ...p, level: level(p.level - 0.25) }
  if (reaction === 'not-useful') return { ...p, weights: weight(weightOf(p, topic) * 0.5) }
  return { ...p, weights: weight(weightOf(p, topic) * 1.25) }
}

export async function react(host: Host, t: Tidbit, reaction: Reaction | 'asked') {
  const next = reacted(await loadPrefs(host), t.topic, reaction)
  await host.global.set(KEY.prefs, next)
  await withHistory(host, history => {
    const i = history.findIndex(h => h.id === t.id)
    if (i < 0) return history
    const change = reaction === 'asked' ? { isAsked: true } : { reaction }
    return history.map((h, j) => (j === i ? { ...h, ...change } : h))
  })
  host.log(`tidbit ${t.id}: ${reaction} -> level ${next.level}, ${t.topic} ${weightOf(next, t.topic)}`)
}

// --- Checks ---

// Page text as plain words, so a quote matches through tags, entities and curly quotes
export const plain = (html: string) =>
  html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

// A failed fetch or a page with too little text is "unverified": keep it.
// A page that loaded without the quote is "missing": drop it
export async function checkQuote(host: Host, url: string, quote: string): Promise<'verified' | 'unverified' | 'missing'> {
  let page: string
  try {
    const res = await host.fetch(url)
    if (!res.ok) {
      host.log(`quote check ${url}: HTTP ${res.status}`)
      return 'unverified'
    }
    page = plain(res.text)
  } catch (err) {
    host.log(`quote check ${url}: ${String(err)}`)
    return 'unverified'
  }
  if (page.length < PAGE_MIN) {
    host.log(`quote check ${url}: only ${page.length} characters of text`)
    return 'unverified'
  }
  const result = page.includes(plain(quote)) ? 'verified' : 'missing'
  host.log(`quote check ${url}: ${result}`)
  return result
}

// Every `--flag` a Claude Code tidbit names must be in `claude --help`
const flagsOk = (t: Pick<Tidbit, 'headline' | 'body' | 'tryIt'>, help: string) => {
  const text = [t.headline, t.body, t.tryIt ?? ''].join(' ')
  if (!/claude/i.test(text) || help === '') return true
  return [...text.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]+)/g)].every(([flag]) => help.includes(flag!))
}

async function claudeOutput(host: Host, arg: string): Promise<string> {
  try {
    const { exitCode, stdout } = await host.run(['claude', arg])
    return exitCode === 0 ? stdout : ''
  } catch {
    return ''
  }
}

// --- Lane 1: the Claude Code CHANGELOG ---

export type Release = { version: string; lines: string[] }

// `## <version>` headings, newest first, each with its `- ` lines
export function splitChangelog(text: string): Release[] {
  const releases: Release[] = []
  for (const line of text.split('\n')) {
    const heading = /^##\s+v?(\d+\.\d+\.\d+)\s*$/.exec(line)
    if (heading) releases.push({ version: heading[1]!, lines: [] })
    else if (/^[-*] /.test(line) && releases.length > 0) releases.at(-1)!.lines.push(line.slice(2).trim())
  }
  return releases
}

// Numerically, so 2.1.99 comes before 2.1.306
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// Release dates by version; the CHANGELOG has none
async function releaseDates(host: Host): Promise<Record<string, string>> {
  try {
    const res = await host.fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) return {}
    const raw = JSON.parse(res.text) as { tag_name?: string; published_at?: string }[]
    return Object.fromEntries(
      raw.flatMap(r => (r.tag_name && r.published_at ? [[r.tag_name.replace(/^v/, ''), r.published_at]] : [])),
    )
  } catch (err) {
    host.log(`releases: ${String(err)}`)
    return {}
  }
}

const ITEM = {
  headline: { type: 'string' },
  body: { type: 'string' },
  tryIt: { type: 'string' },
  quote: { type: 'string' },
}

const CHANGELOG_SCHEMA = {
  type: 'object',
  properties: {
    tidbits: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ...ITEM, version: { type: 'string' }, topic: { type: 'string', enum: TOPICS } },
        required: ['headline', 'body', 'quote', 'version', 'topic'],
      },
    },
  },
  required: ['tidbits'],
}

const WRITING = `Each tip has a headline (one sentence), a body (1-3 short sentences in plain words: what it is and why you'd use it) and, optionally, tryIt (one line or command to try it right away). Put identifiers in backticks.`

const aimAt = (level: number) => `The developer is ${LEVELS[Math.round(level)]}.`

const CHANGELOG_PROMPT = (releases: Release[], today: string, level: number) => `You write short "did you know" tips for a developer who codes with Claude Code. Today is ${today}.

Below are the newest Claude Code release notes. Most lines are bug fixes: pick only the lines that change how someone would work (a new command, flag, setting, hook or behaviour worth trying) and skip the rest. Write 0 to 3 tips in all, not one per line; none is fine.

${WRITING} quote is the release-note line the tip comes from, copied exactly. version is the release it's in. topic is the closest of: ${TOPICS.join(', ')}.

${aimAt(level)}

Release notes:

${releases.map(r => `## ${r.version}\n${r.lines.map(l => `- ${l}`).join('\n')}`).join('\n\n')}`

async function fromChangelog(host: Host, now: number): Promise<Tidbit[]> {
  const cursor = await loadCursor(host)
  const res = await host.fetch(CHANGELOG_URL, { headers: cursor.etag ? { 'If-None-Match': cursor.etag } : {} })
  if (res.status === 304) {
    host.log('changelog: unchanged')
    return []
  }
  if (!res.ok) throw new Error(`changelog: HTTP ${res.status}`)
  const releases = splitChangelog(res.text)
  const dates = await releaseDates(host)
  const installed = (await claudeOutput(host, '--version')).match(/^\d+\.\d+\.\d+/)?.[0] ?? cursor.installed
  const firstSeen: Record<string, string> = {}
  // Only releases newer than the cursor, and on a first run only recent ones
  const fresh = releases
    .filter(r => !cursor.version || compareVersions(r.version, cursor.version) > 0)
    .slice(0, RELEASES_MAX)
    .map(r => {
      const date = dates[r.version] ?? cursor.firstSeen?.[r.version] ?? new Date(now).toISOString()
      if (!dates[r.version]) firstSeen[r.version] = date
      return { ...r, date }
    })
    .filter(r => now - Date.parse(r.date) <= RELEASE_AGE_MAX && r.lines.length > 0)
  const done = { version: releases[0]?.version ?? cursor.version, etag: res.headers.etag, installed, firstSeen }
  host.log(`changelog: ${fresh.length} new releases (${fresh.map(r => r.version).join(', ')})`)
  if (fresh.length === 0) {
    await saveCursor(host, done)
    return []
  }

  const prefs = await loadPrefs(host)
  const { data, cost } = await askClaude(host, CHANGELOG_PROMPT(fresh, day(now), prefs.level), {
    model: TIDBIT_MODEL,
    tools: [],
    cwd: host.globalDir,
    schema: CHANGELOG_SCHEMA,
    budget: BUDGET.changelog,
  })
  host.log(`changelog: cost $${cost ?? '?'}`)
  // Saved only once the model has written its tips, so a failed call tries the same releases again
  await saveCursor(host, done)

  const items = (data as { tidbits?: unknown[] } | undefined)?.tidbits ?? []
  return items.flatMap((raw): Tidbit[] => {
    const t = raw as Partial<Record<'headline' | 'body' | 'tryIt' | 'quote' | 'version' | 'topic', string>>
    const release = fresh.find(r => r.version === t.version)
    // The quote must be a line of that release, or the tip may be made up
    const isQuoted = !!t.quote && !!release?.lines.some(l => plain(l).includes(plain(t.quote!)))
    if (!t.headline || !t.body || !release || !isQuoted || !TOPICS.includes(t.topic as Topic)) {
      host.log(`changelog: dropped ${JSON.stringify(t.headline)}`)
      return []
    }
    return [
      {
        id: `changelog:${release.version}:${hash(t.quote!)}`,
        headline: t.headline,
        body: t.body,
        tryIt: t.tryIt || undefined,
        url: `${CHANGELOG_PAGE}#${release.version.replace(/\./g, '')}`,
        publishedAt: release.date,
        quote: t.quote!,
        topic: t.topic as Topic,
        lane: 'changelog',
        version: release.version,
        expiresAt: new Date(Date.parse(release.date) + FEATURE_TTL).toISOString(),
        isVerified: true,
      },
    ]
  })
}

// --- Lane 2: open-web research ---

const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ...ITEM, url: { type: 'string' }, publishedAt: { type: 'string' } },
        required: ['headline', 'body', 'quote', 'url', 'publishedAt'],
      },
    },
  },
  required: ['items'],
}

const RESEARCH_PROMPT = (topic: Topic, today: string, since: string, level: number, avoid: string[]) => `You research up-to-date tips on coding with LLMs, for a developer who uses Claude Code. Today is ${today}. Your own knowledge is out of date, so rely only on what you find now.

Topic: ${topic}.

Search the web for techniques, workflows and tool features on this topic published on or after ${since}. Prefer primary sources: vendor docs, changelogs and blogs, and the engineering blogs of well-known practitioners. Skip third-party mirrors and aggregators, and anything you can't date. Open each page before you use it.

Find up to 3 items. For each: url (the page itself), publishedAt (the date the page was published, YYYY-MM-DD) and quote (one short sentence copied exactly from the page). ${WRITING} Reply with an empty list if nothing new turns up.

${aimAt(level)}${avoid.length === 0 ? '' : `\n\nThe developer already has these tips:\n${avoid.map(h => `- ${h}`).join('\n')}`}`

// Weighted by your reactions, and never the same topic twice in a row
function pickTopic(p: Prefs, last?: Topic): Topic {
  const topics = TOPICS.filter(t => t !== last)
  const total = topics.reduce((sum, t) => sum + weightOf(p, t), 0)
  let r = (random(10_000) / 10_000) * total
  for (const t of topics) {
    r -= weightOf(p, t)
    if (r < 0) return t
  }
  return topics.at(-1)!
}

async function research(host: Host, now: number): Promise<Tidbit[]> {
  const prefs = await loadPrefs(host)
  const topic = pickTopic(prefs, (await loadCursor(host)).lastTopic)
  const avoid = (await loadTidbits(host)).map(t => t.headline)
  host.log(`research ${topic}: asking claude`)
  const { data, cost } = await askClaude(host, RESEARCH_PROMPT(topic, day(now), day(now - WINDOW), prefs.level, avoid), {
    model: TIDBIT_MODEL,
    tools: ['WebSearch', 'WebFetch'],
    allowed: ['WebSearch', 'WebFetch'],
    // It has no reason to read code
    cwd: host.globalDir,
    schema: RESEARCH_SCHEMA,
    budget: BUDGET.research,
  })
  host.log(`research ${topic}: cost $${cost ?? '?'}`)
  await saveCursor(host, { lastTopic: topic })

  const help = await claudeOutput(host, '--help')
  const items = (data as { items?: unknown[] } | undefined)?.items ?? []
  const found: Tidbit[] = []
  for (const raw of items) {
    const t = raw as Partial<Record<'headline' | 'body' | 'tryIt' | 'quote' | 'url' | 'publishedAt', string>>
    const published = Date.parse(t.publishedAt ?? '')
    const isWhole =
      !!t.headline && !!t.body && !!t.quote && /^https?:\/\//.test(t.url ?? '') && published >= now - WINDOW && published <= now + DAY
    if (!isWhole || !flagsOk(t as Tidbit, help)) {
      host.log(`research: dropped ${JSON.stringify(t.headline)} (${t.url}, ${t.publishedAt})`)
      continue
    }
    const check = await checkQuote(host, t.url!, t.quote!)
    if (check === 'missing') continue
    found.push({
      id: `research:${hash(t.url!)}:${hash(t.headline!)}`,
      headline: t.headline!,
      body: t.body!,
      tryIt: t.tryIt || undefined,
      url: t.url!,
      publishedAt: new Date(published).toISOString(),
      quote: t.quote!,
      topic,
      lane: 'research',
      expiresAt: new Date(published + TECHNIQUE_TTL).toISOString(),
      isVerified: check === 'verified',
    })
  }
  return found
}

// --- Schedule ---

let isRefreshing = false

// Runs whichever lane is due, one at a time; resolves with the tidbits added
export async function refresh(host: Host): Promise<Tidbit[]> {
  if (isRefreshing) return []
  const now = host.now()
  const cursor = await loadCursor(host)
  // The CHANGELOG only has something new after a release, so only research runs sooner
  const researchMs = (await tidbitsReady(host)) < LOW_COUNT ? LOW_REFRESH_MS : REFRESH_MS
  const lane =
    now - (cursor.changelogAt ?? -Infinity) >= REFRESH_MS
      ? 'changelogAt'
      : now - (cursor.researchedAt ?? -Infinity) >= researchMs
        ? 'researchedAt'
        : undefined
  if (!lane) return []
  const interval = lane === 'changelogAt' ? REFRESH_MS : researchMs

  isRefreshing = true
  // Claimed before it runs, so another open session doesn't run it too
  await saveCursor(host, { [lane]: now })
  try {
    const added = await addTidbits(host, lane === 'changelogAt' ? await fromChangelog(host, now) : await research(host, now))
    host.log(`${lane === 'changelogAt' ? 'changelog' : 'research'}: ${added.length} tidbits added`)
    return added
  } catch (err) {
    host.log(`${lane === 'changelogAt' ? 'changelog' : 'research'}: ${String(err)}`)
    await saveCursor(host, { [lane]: now - interval + RETRY_MS })
    return []
  } finally {
    isRefreshing = false
  }
}

// --- Showing ---

export async function installedVersion(host: Host): Promise<string | undefined> {
  return (await loadCursor(host)).installed
}

export function ago(iso: string | undefined, now: number): string | undefined {
  if (!iso) return undefined
  const days = Math.floor((now - Date.parse(iso)) / DAY)
  if (!Number.isFinite(days)) return undefined
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  return `${Math.floor(days / 7)} weeks ago`
}

// Where it's from and when, e.g. "Claude Code 2.1.305 · in your version · 2 days ago"
export function sourceLine(t: Tidbit, now: number, installed?: string): string {
  const host = (() => {
    try {
      return new URL(t.url).hostname.replace(/^www\./, '')
    } catch {
      return t.url
    }
  })()
  const parts =
    t.lane === 'changelog' && t.version
      ? [
          `Claude Code ${t.version}`,
          installed ? (compareVersions(installed, t.version) >= 0 ? 'in your version' : `needs an upgrade to ${t.version}`) : undefined,
        ]
      : [t.lane === 'seed' ? 'Evergreen' : host]
  return [...parts, ago(t.publishedAt, now)].filter(Boolean).join(' · ')
}

// --- Follow-up questions ---

const CHAT_PROMPT = (t: Tidbit, chat: Message[], today: string, installed?: string) => `You help a developer who just read this "did you know" tip about coding with LLMs and has a question about it. Today is ${today}${
  installed ? ` and they run Claude Code ${installed}` : ''
}. Your own knowledge is out of date.

The tip:
${t.headline}
${t.body}${t.tryIt ? `\nTry it: ${t.tryIt}` : ''}
Source: ${t.url}${t.publishedAt ? ` (published ${t.publishedAt.slice(0, 10)})` : ''}

Fetch the source before answering anything you aren't sure of, and search for anything newer. Cite the URLs you used. If you can't confirm something, say so rather than guess. The current directory is the developer's repository: you may read the code to answer "how would I use this here?".

The discussion so far:
${chat.map(m => `${m.from === 'you' ? 'Developer' : 'You'}: ${m.text}`).join('\n\n')}

Reply to the developer's last message in a few short sentences of plain text. Put identifiers in backticks.`

export async function askAboutTidbit(host: Host, t: Tidbit, chat: Message[], root: string): Promise<string> {
  const { text } = await askClaude(host, CHAT_PROMPT(t, chat, day(host.now()), await installedVersion(host)), {
    model: TIDBIT_MODEL,
    tools: ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'],
    allowed: ['WebSearch', 'WebFetch'],
    cwd: root,
    budget: BUDGET.chat,
  })
  return text
}
