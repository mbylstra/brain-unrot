// The quiz UI. It talks to its host only through messages (a `view` snapshot in, actions out),
// so the same bundle could later be served elsewhere, e.g. as an MCP App
import hljs from 'highlight.js/lib/common'
import { Marked } from 'marked'

import type { FromWebview, ToWebview, View } from '../src/panel'
import type { Message, Question, Reaction, Tidbit } from '../src/core/types'
import css from './style.css'

declare function acquireVsCodeApi(): { postMessage(message: unknown): void }

const NO_IDEA = -1
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

const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: (m: unknown) => window.parent.postMessage(m, '*') }
const send = (message: FromWebview) => vscode.postMessage(message)

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// Model text is Markdown. Raw HTML in it is shown as text, and code blocks are highlighted
const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => escape(text),
    code: ({ text, lang }) => {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined
      const highlighted = language ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value
      return `<pre><code class="hljs">${highlighted}</code></pre>`
    },
  },
})

// --- DOM helpers ---

type Child = Node | string | null | undefined | false
function h(tag: string, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children) if (c) el.append(c)
  return el
}

const md = (text: string, className = 'md') => {
  const el = h('div', { class: className })
  el.innerHTML = markdown.parse(text) as string
  return el
}

// Short text with `code` in it: a prompt, a choice
const inline = (text: string, tag = 'span', className?: string) => {
  const el = h(tag, { class: className })
  el.innerHTML = markdown.parseInline(text) as string
  return el
}

// A button with a key: pressing the key (outside a text box) presses the button
function button(label: string, hotkey: string | undefined, onPress: () => void, options: { variant?: 'choice' | 'primary' | 'plain'; content?: Node } = {}) {
  const el = h(
    'button',
    { class: `button ${options.variant ?? 'plain'}`, 'data-hotkey': hotkey, title: hotkey ? `Press ${hotkey === 'Enter' ? 'Enter' : hotkey.toUpperCase()}` : undefined },
    hotkey && hotkey !== 'Enter' ? h('kbd', {}, hotkey) : null,
    options.content ?? h('span', {}, label),
  )
  el.addEventListener('click', onPress)
  return el
}

// --- Text boxes ---

// The chat and issue boxes keep what you type across redraws, until you send it
const boxes = new Map<string, HTMLTextAreaElement>()
// What each box does with its text when sent; set on every draw
const onSubmitFor = new Map<string, (text: string) => void>()
let focusNext: string | undefined
let draftsFor: string | undefined

function submitBox(key: string) {
  const area = boxes.get(key)
  const text = area?.value.trim() ?? ''
  if (!area || text === '') return
  area.value = ''
  onSubmitFor.get(key)?.(text)
}

function box(key: string, placeholder: string, submitLabel: string, onSubmit: (text: string) => void) {
  let area = boxes.get(key)
  if (!area) {
    const el = h('textarea', { rows: '3' }) as HTMLTextAreaElement
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        submitBox(key)
      } else if (e.key === 'Escape') el.blur()
    })
    boxes.set(key, el)
    area = el
  }
  area.placeholder = placeholder
  onSubmitFor.set(key, onSubmit)
  return h(
    'div',
    { class: 'box' },
    area,
    h('div', { class: 'box-actions' }, h('span', { class: 'dim' }, 'Enter to send, Shift+Enter for a new line'), button(submitLabel, undefined, () => submitBox(key))),
  )
}

// --- Screens ---

const dim = (text: string) => h('div', { class: 'dim' }, text)

function transcript(chat: Message[], isThinking: boolean | undefined) {
  return h(
    'div',
    { class: 'chat' },
    ...chat.map(m => (m.from === 'you' ? h('div', { class: 'you' }, h('strong', {}, 'You: '), m.text) : md(m.text, 'md claude'))),
    isThinking ? h('div', { class: 'dim thinking' }, 'Claude is thinking…') : null,
  )
}

function chatBox(view: View, placeholder: string) {
  const round = view.round!
  if (!round.chat) return null
  return h(
    'div',
    { class: 'stack' },
    transcript(round.chat, round.isThinking),
    box('ask', round.chat.length === 0 ? placeholder : 'Ask a follow-up…', 'Ask', text => send({ type: 'send', text })),
  )
}

const askButton = (label: string) =>
  button(label, '6', () => {
    focusNext = 'ask'
    send({ type: 'ask' })
  })

const reportButton = () =>
  button('Suggest improvement or file a bug', '7', () => {
    focusNext = 'issue'
    send({ type: 'report' })
  })

const sourceOf = (q: Question) =>
  q.sourceFile
    ? `From ${q.sourceFile}`
    : q.category === 'concept'
      ? `General concept: ${q.topic}`
      : q.category === 'instructions'
        ? "About the project's instructions for Claude"
        : 'Warm-up question'

function claudeReady() {
  return h(
    'div',
    { class: 'stack ready' },
    h('div', { class: 'big' }, '✓ Claude is ready'),
    h('div', {}, 'Switch back to Claude, or keep going with another question.'),
    button('Keep going', 'n', () => send({ type: 'keepGoing' }), { variant: 'primary' }),
  )
}

function preference(view: View) {
  const categories = view.preference!.categories
  return h(
    'div',
    { class: 'stack' },
    h('h2', {}, 'Which would you like more of?'),
    h(
      'div',
      { class: 'choices' },
      ...categories.map((c, i) => button(c.label, String(i + 1), () => send({ type: 'prefer', category: c.category }), { variant: 'choice' })),
      button('No preference', 's', () => send({ type: 'prefer' })),
    ),
    dim(`Each kind comes up in proportion to its weight, now ${categories.map(c => c.weight).join(' : ')}. Your pick adds 1.`),
  )
}

function issueScreen(view: View) {
  const round = view.round!
  const heading = round.kind === 'tidbit' ? round.tidbit.headline : round.question.prompt
  return h(
    'div',
    { class: 'stack' },
    inline(heading, 'h2'),
    h('div', {}, round.kind === 'tidbit' ? 'What could be better? Out of date, wrong, unclear…' : 'What could be better? A confusing name, a bug, a wrong question…'),
    box('issue', 'Describe the issue…', 'File', text => send({ type: 'submitIssue', text })),
    button('Cancel', 'c', () => send({ type: 'cancelIssue' })),
    dim(`Claude rewrites it and saves it to ${view.issuesDir}/.`),
  )
}

function tidbitScreen(view: View, tidbit: Tidbit, reaction: Reaction | null) {
  return h(
    'div',
    { class: 'stack' },
    h('div', {}, h('div', { class: 'tidbit-label' }, '💡 Did you know?'), dim(view.tidbitSource ?? '')),
    inline(tidbit.headline, 'h2'),
    md(tidbit.body),
    tidbit.tryIt ? h('div', { class: 'try' }, h('strong', {}, 'Try it: '), inline(tidbit.tryIt)) : null,
    h(
      'div',
      { class: 'dim' },
      'Source: ',
      h('a', { href: tidbit.url }, tidbit.url),
      tidbit.lane === 'research' && !tidbit.isVerified ? ' (quote not checked)' : '',
    ),
    reaction === null
      ? h('div', { class: 'choices' }, ...REACTIONS.map(([r, label], i) => button(label, String(i + 1), () => send({ type: 'react', reaction: r }), { variant: 'choice' })))
      : h('div', { class: 'right' }, THANKS[reaction]),
    chatBox(view, 'Ask about this tidbit…') ?? askButton('Ask about this'),
    button('Next', 'n', () => send({ type: 'next' }), { variant: 'primary' }),
    reportButton(),
  )
}

function offerScreen(question: Question) {
  return h(
    'div',
    { class: 'stack' },
    h('h2', {}, 'Would you like more questions about ', h('code', {}, question.sourceFile ?? ''), '?'),
    h(
      'div',
      { class: 'choices' },
      button('Yes', '1', () => send({ type: 'moreAboutFile', isYes: true }), { variant: 'choice' }),
      button('No', '2', () => send({ type: 'moreAboutFile', isYes: false }), { variant: 'choice' }),
    ),
  )
}

function questionScreen(view: View, question: Question, guess: number | null) {
  const head = [dim(sourceOf(question)), inline(question.prompt, 'h2')]
  if (guess === null) {
    return h(
      'div',
      { class: 'stack' },
      ...head,
      h(
        'div',
        { class: 'choices' },
        ...question.choices.map((c, i) => button(c, String(i + 1), () => send({ type: 'choose', index: i }), { variant: 'choice', content: inline(c) })),
        button('Absolutely no idea', '5', () => send({ type: 'choose', index: NO_IDEA }), { variant: 'choice' }),
      ),
      chatBox(view, 'Ask about the question…') ?? askButton('Ask a clarifying question'),
      button('Skip this question', 's', () => send({ type: 'skip' })),
      reportButton(),
    )
  }
  const isRight = guess === question.answer
  const correct = `${question.answer + 1}. ${question.choices[question.answer]}`
  const verdict =
    guess === NO_IDEA
      ? h('div', { class: 'verdict unsure' }, 'No worries — it was ', inline(correct))
      : isRight
        ? h('div', { class: 'verdict right' }, 'Correct!')
        : h('div', { class: 'verdict wrong' }, 'Wrong — it was ', inline(correct))
  return h(
    'div',
    { class: 'stack' },
    ...head,
    h(
      'ol',
      { class: 'answered' },
      ...question.choices.map((c, i) => h('li', { class: i === question.answer ? 'is-answer' : i === guess ? 'is-guess' : undefined }, inline(c))),
    ),
    verdict,
    question.explanation ? md(question.explanation) : null,
    // A discussion from before answering carries on here, now about the answer
    chatBox(view, 'Ask about the answer…') ?? askButton('Ask about the answer'),
    button('Next question', 'n', () => send({ type: 'next' }), { variant: 'primary' }),
    reportButton(),
  )
}

function body(view: View): HTMLElement {
  if (view.isClaudeReady) return claudeReady()
  if (view.preference) return preference(view)
  const round = view.round
  if (round === null) {
    // Generation doesn't start a round, so Next checks again
    return h('div', { class: 'stack' }, dim('No new question yet. More are on the way.'), button('Next question', 'n', () => send({ type: 'next' }), { variant: 'primary' }))
  }
  if (round.issue) return issueScreen(view)
  if (round.kind === 'tidbit') return tidbitScreen(view, round.tidbit, round.reaction)
  if (round.isOffering && round.question.sourceFile) return offerScreen(round.question)
  return questionScreen(view, round.question, round.guess)
}

function render(view: View) {
  const app = document.getElementById('app')!
  // Drafts belong to a round: a new round starts with empty boxes
  const roundId = view.round ? (view.round.kind === 'tidbit' ? view.round.tidbit.id : view.round.question.id) : undefined
  if (roundId !== draftsFor) {
    boxes.forEach(b => (b.value = ''))
    draftsFor = roundId
  }
  // Moving a text box in the page loses its focus and cursor, so note them and put them back
  const active = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : undefined
  const selection = active ? [active.selectionStart, active.selectionEnd] : undefined
  const scroll = window.scrollY

  app.replaceChildren(
    view.isClaudeFinished && !view.isClaudeReady ? h('div', { class: 'banner' }, '✓ Claude is ready. Finish this one, then switch back.') : '',
    body(view),
    h(
      'footer',
      {},
      view.notice ? h('div', {}, view.notice) : null,
      h(
        'div',
        { class: 'dim' },
        `Difficulty ${Math.floor(view.skill.difficulty)} out of ${view.difficultyMax} · ${view.ready} generated questions ready · ${view.tips} tidbits ready`,
      ),
    ),
  )

  const target = focusNext ? boxes.get(focusNext) : active
  if (target && target.isConnected) {
    target.focus()
    if (selection && target === active) target.setSelectionRange(selection[0] ?? null, selection[1] ?? null)
    if (focusNext) focusNext = undefined
  }
  window.scrollTo(0, scroll)
}

// --- Keys ---

document.addEventListener('keydown', e => {
  if (e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return
  const key = e.key.toLowerCase()
  const pressed =
    document.querySelector<HTMLButtonElement>(`button[data-hotkey="${CSS.escape(key)}"]`) ??
    (key === 'enter' && !(e.target instanceof HTMLButtonElement) ? document.querySelector<HTMLButtonElement>('button.primary') : null)
  if (!pressed) return
  e.preventDefault()
  pressed.click()
})

// --- Start ---

const style = document.createElement('style')
style.textContent = css
document.head.append(style)

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  if (e.data?.type === 'view') render(e.data.view)
})
send({ type: 'ready' })
