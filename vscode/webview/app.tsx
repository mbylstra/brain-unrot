// The screens. Each draws one snapshot of the quiz; every action goes back to the extension
import hljs from 'highlight.js/lib/common'
import { CircleCheck, CircleHelp, CircleX, Lightbulb } from 'lucide-react'
import { Marked } from 'marked'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

import type { View } from '../src/panel'
import type { Message, Question, Reaction, Tidbit } from '../src/core/types'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Kbd } from '@/components/ui/kbd'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { send } from './messages'

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

// Tailwind's typography, with inline code as shadcn draws it and code blocks on the muted background
const PROSE = cn(
  'prose prose-sm prose-neutral max-w-none text-foreground dark:prose-invert',
  'prose-code:rounded prose-code:bg-muted prose-code:px-[0.3rem] prose-code:py-[0.2rem] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none',
  'prose-pre:bg-muted prose-pre:text-foreground [&_pre_code]:bg-transparent [&_pre_code]:p-0',
)

const Markdown = ({ text, className }: { text: string; className?: string }) => (
  <div className={cn(PROSE, className)} dangerouslySetInnerHTML={{ __html: markdown.parse(text) as string }} />
)

// Short text with `code` in it: a prompt, a choice
const Inline = ({ text }: { text: string }) => <span dangerouslySetInnerHTML={{ __html: markdown.parseInline(text) as string }} />

// --- Buttons ---

type Variant = 'choice' | 'primary' | 'plain'

// A button with a key: pressing the key (outside a text box) presses the button
function KeyButton({ hotkey, variant = 'plain', onPress, children }: { hotkey?: string; variant?: Variant; onPress: () => void; children: ReactNode }) {
  return (
    <Button
      variant={variant === 'primary' ? 'default' : variant === 'choice' ? 'outline' : 'ghost'}
      size={variant === 'plain' ? 'sm' : 'default'}
      className={cn(variant === 'choice' && 'h-auto w-full justify-start py-2 text-left whitespace-normal', variant === 'plain' && 'text-muted-foreground')}
      data-hotkey={hotkey}
      data-primary={variant === 'primary' || undefined}
      title={hotkey ? `Press ${hotkey === 'Enter' ? 'Enter' : hotkey.toUpperCase()}` : undefined}
      onClick={onPress}
    >
      {hotkey && hotkey !== 'Enter' ? <Kbd className={cn(variant === 'primary' && 'bg-primary-foreground/20 text-primary-foreground')}>{hotkey.toUpperCase()}</Kbd> : null}
      <span>{children}</span>
    </Button>
  )
}

// --- Text boxes ---

// The chat and issue boxes keep what you type across redraws, until you send it or the round changes.
// `focusNext` names the box to focus once it's drawn: only after you press Ask or Report, never on its own
type Drafts = { text: Record<string, string>; setText: (key: string, text: string) => void; focusNext: { current: string | undefined } }
const DraftsContext = createContext<Drafts | null>(null)

function useDrafts(roundId: string | undefined): Drafts {
  const [drafts, setDrafts] = useState<{ roundId: string | undefined; text: Record<string, string> }>({ roundId, text: {} })
  const focusNext = useRef<string>(undefined)
  // Drafts belong to a round: a new round starts with empty boxes
  if (drafts.roundId !== roundId) setDrafts({ roundId, text: {} })
  return {
    text: drafts.roundId === roundId ? drafts.text : {},
    setText: (key, text) => setDrafts(d => ({ ...d, text: { ...d.text, [key]: text } })),
    focusNext,
  }
}

function Box({ name, placeholder, submitLabel, onSubmit }: { name: string; placeholder: string; submitLabel: string; onSubmit: (text: string) => void }) {
  const drafts = useContext(DraftsContext)!
  const area = useRef<HTMLTextAreaElement>(null)
  const value = drafts.text[name] ?? ''

  useEffect(() => {
    if (drafts.focusNext.current !== name) return
    drafts.focusNext.current = undefined
    area.current?.focus()
  })

  const submit = () => {
    const text = value.trim()
    if (text === '') return
    drafts.setText(name, '')
    onSubmit(text)
  }

  return (
    <div className="flex w-full flex-col gap-1.5">
      <Textarea
        ref={area}
        rows={3}
        value={value}
        placeholder={placeholder}
        className="min-h-20 resize-y"
        onChange={e => drafts.setText(name, e.target.value)}
        onKeyDown={e => {
          // VS Code forwards key presses from the webview's window to its own keybindings, where
          // `inputFocus` is false, so a binding like "space a" would fire while typing. Keep plain keys
          // here, and let ones with a modifier through so Cmd+S and the like still work.
          if (!e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation()
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') e.currentTarget.blur()
        }}
      />
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Enter to send, Shift+Enter for a new line</span>
        <Button size="sm" variant="secondary" onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}

// --- Pieces ---

const Dim = ({ children }: { children: ReactNode }) => <div className="text-muted-foreground">{children}</div>
const Choices = ({ children }: { children: ReactNode }) => <div className="flex w-full flex-col gap-1.5">{children}</div>
const Actions = ({ children }: { children: ReactNode }) => <CardFooter className="flex-col items-start gap-2">{children}</CardFooter>

function Transcript({ chat, isThinking }: { chat: Message[]; isThinking: boolean | undefined }) {
  return (
    <div className="flex w-full flex-col gap-2">
      {chat.map((m, i) =>
        m.from === 'you' ? (
          <div key={i} className="self-end rounded-lg bg-secondary px-3 py-2 text-secondary-foreground">
            {m.text}
          </div>
        ) : (
          <Markdown key={i} text={m.text} className="border-l-2 pl-3" />
        ),
      )}
      {isThinking ? <div className="animate-pulse text-muted-foreground">Claude is thinking…</div> : null}
    </div>
  )
}

function ChatBox({ view, placeholder }: { view: View; placeholder: string }) {
  const round = view.round!
  if (!round.chat) return null
  return (
    <CardContent className="flex flex-col gap-3 border-t pt-4">
      <Transcript chat={round.chat} isThinking={round.isThinking} />
      <Box name="ask" placeholder={round.chat.length === 0 ? placeholder : 'Ask a follow-up…'} submitLabel="Ask" onSubmit={text => send({ type: 'send', text })} />
    </CardContent>
  )
}

function AskButton({ view, label }: { view: View; label: string }) {
  const drafts = useContext(DraftsContext)!
  if (view.round?.chat) return null
  return (
    <KeyButton
      hotkey="6"
      onPress={() => {
        drafts.focusNext.current = 'ask'
        send({ type: 'ask' })
      }}
    >
      {label}
    </KeyButton>
  )
}

function ReportButton() {
  const drafts = useContext(DraftsContext)!
  return (
    <KeyButton
      hotkey="7"
      onPress={() => {
        drafts.focusNext.current = 'issue'
        send({ type: 'report' })
      }}
    >
      Suggest improvement or file a bug
    </KeyButton>
  )
}

const sourceOf = (q: Question) =>
  q.sourceFile
    ? `From ${q.sourceFile}`
    : q.category === 'concept'
      ? `General concept: ${q.topic}`
      : q.category === 'instructions'
        ? "About the project's instructions for Claude"
        : q.category === 'plans'
          ? "About the project's plans"
          : 'Warm-up question'

// --- Screens ---

function ClaudeReady() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg text-success">
          <CircleCheck className="size-5" /> Claude is ready
        </CardTitle>
        <CardDescription>Switch back to Claude, or keep going with another question.</CardDescription>
      </CardHeader>
      <Actions>
        <KeyButton hotkey="n" variant="primary" onPress={() => send({ type: 'keepGoing' })}>
          Keep going
        </KeyButton>
      </Actions>
    </Card>
  )
}

function Preference({ view }: { view: View }) {
  const categories = view.preference!.categories
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Which would you like more of?</CardTitle>
        <CardDescription>
          Each kind comes up in proportion to its weight, now {categories.map(c => c.weight).join(' : ')}. Your pick adds 1.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Choices>
          {categories.map((c, i) => (
            <KeyButton key={c.category} hotkey={String(i + 1)} variant="choice" onPress={() => send({ type: 'prefer', category: c.category })}>
              {c.label}
            </KeyButton>
          ))}
        </Choices>
      </CardContent>
      <Actions>
        <KeyButton hotkey="s" onPress={() => send({ type: 'prefer' })}>
          No preference
        </KeyButton>
      </Actions>
    </Card>
  )
}

function IssueScreen({ view }: { view: View }) {
  const round = view.round!
  const heading = round.kind === 'tidbit' ? round.tidbit.headline : round.question.prompt
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg leading-snug">
          <Inline text={heading} />
        </CardTitle>
        <CardDescription>
          {round.kind === 'tidbit' ? 'What could be better? Out of date, wrong, unclear…' : 'What could be better? A confusing name, a bug, a wrong question…'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Box name="issue" placeholder="Describe the issue…" submitLabel="File" onSubmit={text => send({ type: 'submitIssue', text })} />
        <Dim>Claude rewrites it and saves it to {view.issuesDir}/.</Dim>
      </CardContent>
      <Actions>
        <KeyButton hotkey="c" onPress={() => send({ type: 'cancelIssue' })}>
          Cancel
        </KeyButton>
      </Actions>
    </Card>
  )
}

function TidbitScreen({ view, tidbit, reaction }: { view: View; tidbit: Tidbit; reaction: Reaction | null }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-1.5 font-semibold text-warning">
          <Lightbulb className="size-4" /> Did you know?
        </div>
        {view.tidbitSource ? <CardDescription>{view.tidbitSource}</CardDescription> : null}
        <CardTitle className="text-lg leading-snug">
          <Inline text={tidbit.headline} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Markdown text={tidbit.body} />
        {tidbit.tryIt ? (
          <Alert>
            <AlertTitle>Try it</AlertTitle>
            <AlertDescription>
              <Inline text={tidbit.tryIt} />
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="text-xs text-muted-foreground">
          Source: <a href={tidbit.url}>{tidbit.url}</a>
          {tidbit.lane === 'research' && !tidbit.isVerified ? ' (quote not checked)' : ''}
        </div>
        {reaction === null ? (
          <Choices>
            {REACTIONS.map(([r, label], i) => (
              <KeyButton key={r} hotkey={String(i + 1)} variant="choice" onPress={() => send({ type: 'react', reaction: r })}>
                {label}
              </KeyButton>
            ))}
          </Choices>
        ) : (
          <div className="text-success">{THANKS[reaction]}</div>
        )}
      </CardContent>
      <ChatBox view={view} placeholder="Ask about this tidbit…" />
      <Actions>
        <KeyButton hotkey="n" variant="primary" onPress={() => send({ type: 'next' })}>
          Next
        </KeyButton>
        <AskButton view={view} label="Ask about this" />
        <ReportButton />
      </Actions>
    </Card>
  )
}

function OfferScreen({ question }: { question: Question }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg leading-snug">
          Would you like more questions about <code>{question.sourceFile ?? ''}</code>?
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Choices>
          <KeyButton hotkey="1" variant="choice" onPress={() => send({ type: 'moreAboutFile', isYes: true })}>
            Yes
          </KeyButton>
          <KeyButton hotkey="2" variant="choice" onPress={() => send({ type: 'moreAboutFile', isYes: false })}>
            No
          </KeyButton>
        </Choices>
      </CardContent>
    </Card>
  )
}

function Verdict({ question, guess }: { question: Question; guess: number }) {
  const correct = `${question.answer + 1}. ${question.choices[question.answer]}`
  if (guess === question.answer) {
    return (
      <Alert variant="success">
        <CircleCheck />
        <AlertTitle>Correct!</AlertTitle>
      </Alert>
    )
  }
  const isUnsure = guess === NO_IDEA
  return (
    <Alert className={isUnsure ? 'border-warning/50 text-warning' : 'border-destructive/50 text-destructive'}>
      {isUnsure ? <CircleHelp /> : <CircleX />}
      <AlertTitle>{isUnsure ? 'No worries' : 'Wrong'}</AlertTitle>
      <AlertDescription className="text-current/90">
        <span>
          It was <Inline text={correct} />
        </span>
      </AlertDescription>
    </Alert>
  )
}

function QuestionScreen({ view, question, guess }: { view: View; question: Question; guess: number | null }) {
  const header = (
    <CardHeader>
      <CardDescription>{sourceOf(question)}</CardDescription>
      <CardTitle className="text-lg leading-snug">
        <Inline text={question.prompt} />
      </CardTitle>
    </CardHeader>
  )
  if (guess === null) {
    return (
      <Card>
        {header}
        <CardContent>
          <Choices>
            {question.choices.map((c, i) => (
              <KeyButton key={i} hotkey={String(i + 1)} variant="choice" onPress={() => send({ type: 'choose', index: i })}>
                <Inline text={c} />
              </KeyButton>
            ))}
            <KeyButton hotkey="5" variant="choice" onPress={() => send({ type: 'choose', index: NO_IDEA })}>
              Absolutely no idea
            </KeyButton>
          </Choices>
        </CardContent>
        <ChatBox view={view} placeholder="Ask about the question…" />
        <Actions>
          <AskButton view={view} label="Ask a clarifying question" />
          <KeyButton hotkey="s" onPress={() => send({ type: 'skip' })}>
            Skip this question
          </KeyButton>
          <ReportButton />
        </Actions>
      </Card>
    )
  }
  return (
    <Card>
      {header}
      <CardContent className="flex flex-col gap-3">
        <ol className="flex flex-col gap-1.5">
          {question.choices.map((c, i) => {
            const isAnswer = i === question.answer
            const isGuess = i === guess
            return (
              <li
                key={i}
                className={cn(
                  'flex items-start gap-2 rounded-md border px-3 py-2',
                  isAnswer && 'border-success/60 bg-success/10 font-medium',
                  isGuess && !isAnswer && 'border-destructive/60 bg-destructive/10 text-muted-foreground line-through',
                )}
              >
                <span className="text-muted-foreground tabular-nums">{i + 1}.</span>
                <Inline text={c} />
              </li>
            )
          })}
        </ol>
        <Verdict question={question} guess={guess} />
        {question.explanation ? <Markdown text={question.explanation} /> : null}
      </CardContent>
      {/* A discussion from before answering carries on here, now about the answer */}
      <ChatBox view={view} placeholder="Ask about the answer…" />
      <Actions>
        <KeyButton hotkey="n" variant="primary" onPress={() => send({ type: 'next' })}>
          Next question
        </KeyButton>
        <AskButton view={view} label="Ask about the answer" />
        <ReportButton />
      </Actions>
    </Card>
  )
}

function Body({ view }: { view: View }) {
  if (view.isClaudeReady) return <ClaudeReady />
  if (view.preference) return <Preference view={view} />
  const round = view.round
  if (round === null) {
    // Generation doesn't start a round, so Next checks again
    return (
      <Card>
        <CardHeader>
          <CardDescription>No new question yet. More are on the way.</CardDescription>
        </CardHeader>
        <Actions>
          <KeyButton hotkey="n" variant="primary" onPress={() => send({ type: 'next' })}>
            Next question
          </KeyButton>
        </Actions>
      </Card>
    )
  }
  if (round.issue) return <IssueScreen view={view} />
  if (round.kind === 'tidbit') return <TidbitScreen view={view} tidbit={round.tidbit} reaction={round.reaction} />
  if (round.isOffering && round.question.sourceFile) return <OfferScreen question={round.question} />
  return <QuestionScreen view={view} question={round.question} guess={round.guess} />
}

export function App({ view }: { view: View }) {
  const roundId = view.round ? (view.round.kind === 'tidbit' ? view.round.tidbit.id : view.round.question.id) : undefined
  const drafts = useDrafts(roundId)
  return (
    <DraftsContext.Provider value={drafts}>
      {/* Focusable, so clicking or selecting text focuses this and not <body>. Before a copy, VS Code
          refocuses the last focused element when <body> has the focus: a text box, which drops the selection */}
      <div tabIndex={-1} className="mx-auto flex max-w-3xl flex-col gap-4 p-4 outline-none">
        {view.isClaudeFinished && !view.isClaudeReady ? (
          <Alert variant="success">
            <CircleCheck />
            <AlertTitle>Claude is ready. Finish this one, then switch back.</AlertTitle>
          </Alert>
        ) : null}
        <Body view={view} />
        <footer className="flex flex-col gap-1 border-t pt-3 text-xs text-muted-foreground">
          {view.notice ? <div className="text-foreground">{view.notice}</div> : null}
          <div>
            Difficulty {Math.floor(view.skill.difficulty)} out of {view.difficultyMax} · {view.ready} generated questions ready · {view.tips} tidbits ready
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>Weights: {view.weights.map(w => `${w.name} ${w.weight}`).join(' · ')}</span>
            <Button variant="outline" size="xs" onClick={() => send({ type: 'resetWeights' })}>
              Reset weights
            </Button>
          </div>
        </footer>
      </div>
    </DraftsContext.Provider>
  )
}
