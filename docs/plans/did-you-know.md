# Did you know: up-to-date tips on coding with LLMs

## Context

A second mode for the pane, alongside the quiz: instead of a question, it
shows one short tidbit about using LLMs to write code. Tidbits range from
specific Claude Code features (a new flag, a hook event, a slash command)
to general techniques (prompting, context management, verification
loops). You can ask follow-up questions about a tidbit, and Claude may
search the web to answer.

The hard part is freshness. This knowledge changes weekly, and the model's
own training data is months old. A quick test makes the point. A headless
`claude -p` asked to WebSearch for "the latest Claude Code version" came
back with **2.1.285**, citing a third-party changelog mirror. The installed
version was **2.1.306**, and the official CHANGELOG already listed it.
Open-web search alone will confidently serve stale news, so the design
leans on primary sources first.

This builds on two ideas in [quiz-ideas.md](quiz-ideas.md): *Claude Code
features* (generate "what's new" items from the changelog) and *Going
stale* (LLM knowledge gets a time-to-live).

## What a tidbit looks like

```
💡 Did you know?                          Claude Code 2.1.305 · 2 days ago
`/effort` now applies when your model name differs from a
`modelOverrides` value only by letter case or a `[1m]` tag.

Try it: …one line or command…
Source: github.com/anthropics/claude-code CHANGELOG.md

1. Knew it   2. New to me   3. Not useful   6. Ask about this   7. File a bug
```

- **Headline and body**: 1–3 sentences, plain words, identifiers in
  backticks.
- **Try it**: an optional one-liner you can act on right away.
- **Source**: a URL and a published date. Every tidbit has both, or it's
  dropped.
- **Reactions instead of an answer**: there's no right answer, so the keys
  record a reaction. "Knew it" and "New to me" tune how basic or advanced
  later tidbits are (the tidbit version of difficulty). "Not useful" lowers
  the weight of that topic.

## Two lanes of sources

### Lane 1: deterministic feeds (cheap and exact)

The plugin fetches these itself with `$.http.fetch`, with no LLM involved,
and keeps a cursor of what it has already processed:

- **Claude Code CHANGELOG**:
  `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`
  (checked: public, about 1 MB, `## <version>` headings, newest first).
  Split it on headings and take only versions newer than the cursor.
- Nothing else: lane 1 covers Claude Code only. Other tools' changelogs
  and Anthropic's general news are left out.

Only the new entries go to the model, which turns them into tidbits:
explain the feature, why you'd use it, and how to try it. That call is
cheap and needs no tools.

- **Ground against the local install.** Run `claude --version` and tag
  each tidbit "in your version" or "needs an upgrade to 2.1.x". Tidbits
  about versions older than about 2 months are skipped by default.
- **Dates.** The CHANGELOG has none. Take dates from the GitHub releases
  API (`api.github.com/repos/anthropics/claude-code/releases`) if it lists
  these versions, or fall back to the date the plugin first saw the
  version.
- **Filtering.** Most changelog lines are bug fixes. Have the model pick
  only the lines that change how you'd work, and skip the rest. A digest
  of 3 releases should produce 0–3 tidbits, not 30.

### Lane 2: open-web research (general techniques)

For things no single feed covers: prompting techniques, workflows people
are converging on (plan mode, subagents, TDD loops, worktrees), and
evaluation habits.

- A `claude -p` child with
  `--tools WebSearch,WebFetch --allowedTools WebSearch,WebFetch`
  (checked: works headless, with no permission denials). Run it from a
  neutral cwd such as the plugin's data directory, not the repo, since it
  has no reason to read code.
- The prompt includes **today's date**, says its own knowledge is out of
  date, and asks for items **published in the last 30 days** from named,
  preferably primary, sources: vendor docs and blogs, and the engineering
  blogs of well-known practitioners. Each item comes back with a URL, a
  published date and a short verbatim quote.
- **Topic rotation**, so a research run doesn't keep finding the same
  thing: context management, prompting, agents and subagents, testing and
  verification, cost and model choice, security, IDE and CLI workflow.
  Pick the next topic weighted by the reactions.
- **Model**: Sonnet by default, for research and for writing tidbits, and
  for follow-up chat about them. Haiku took the first search result at
  face value in the test above. The model is one constant, so it's easy to
  change later.

## Checking tidbits before they reach the queue

The "check quoted code" idea in quiz-ideas.md, applied to the web:

- **Validate the structure** with `--json-schema` and
  `--output-format json` (checked: the reply has a `structured_output`
  field), instead of the bracket-slicing in `parseQuestions`.
- **Require a source URL, a published date inside the window and a quote.**
  Drop anything missing one of them.
- **Check the quote.** The plugin fetches the source URL with
  `$.http.fetch` and confirms the quote appears in it (after normalising
  whitespace). This costs nothing extra, and it catches made-up URLs and
  paraphrases dressed up as quotes. Pages rendered by JavaScript will fail
  it, so treat a failed fetch as "unverified" and keep the tidbit, but
  treat "page loaded, quote missing" as a drop.
- **Check Claude Code claims locally where possible.** If a tidbit names a
  CLI flag, look for it in `claude --help`. If it names a slash command or
  setting, check the CHANGELOG text the plugin already has.
- **Dedupe** by URL and by a normalised headline. Keep a global known-set
  of tidbit hashes so the same news isn't shown twice across projects.

## Schedule, storage and cost

- **Research is infrequent; showing is instant.** At `session.start`, if
  the digest is more than about 24 hours old, queue one lane 1 refresh
  and one lane 2 research job. They run on the existing `$.clock.every`
  pattern, one job in flight, separate from question generation. With
  fewer than 5 tidbits ready, research runs hourly instead, so the queue
  doesn't stay empty for a day once it's been shown.
- **Global storage**, since this knowledge isn't per repo: `tidbits`
  (about 40 ready, newest first), `tidbits:known` (hashes of every tidbit ever queued),
  `tidbits:cursor` (the last CHANGELOG version and feed entry dates),
  `tidbits:prefs` (topic weights and the knew-it / new-to-me balance),
  `tidbits:history` (the last 500 tidbits shown, with your reaction). All
  are small next to the 4 MiB cap.
- **Expiry.** Each tidbit gets `expiresAt` (about 6 weeks for features,
  12 for general techniques) and is dropped when served past it. When
  picking a tidbit, prefer newer ones.
- **Cost.** No daily cap. Each call still passes `--max-budget-usd` as a
  guard against a runaway call, and `total_cost_usd` goes in the debug
  log. For scale: one WebSearch round trip on Haiku cost about $0.02, and
  Sonnet costs a few times that. Research runs about once a day.
- **Seed tidbits.** About 10 hand-written evergreen ones (`/clear` vs
  `/compact`, CLAUDE.md, plan mode, asking for tests first), so the very
  first run isn't empty while research runs.

## Follow-up questions

Press 6 to ask about a tidbit. This reuses `discuss` and the chat box
as-is, with these changes:

- **`askClaude` takes its tools as an argument.** It hardcodes
  `Read,Grep,Glob` today. Tidbit chat gets
  `WebSearch,WebFetch,Read,Grep,Glob` and runs from the repo root, so it
  can also answer "how would I use this here?" by looking at the code.
- **A tidbit version of `CHAT_PROMPT`** includes the tidbit, its source
  URL and date, today's date and your Claude Code version. It tells Claude
  to fetch the source before answering anything it isn't sure about, to
  search for anything newer, to cite URLs, and to say so when it can't
  confirm something rather than guess.
- **Replies are slower**: about 15 seconds with a search. The existing
  "Claude is thinking…" state covers that.
- **Asking counts as a reaction.** A tidbit you asked about weights its
  topic up.
- **"File a bug" (7) still works**, and is mostly useful for "this tidbit
  is wrong or out of date".

## Changes to the code

- **`types/index.d.ts`**: add a `Tidbit` type (`id`, `headline`, `body`,
  `tryIt?`, `url`, `publishedAt`, `quote`, `topic`, `lane`, `version?`,
  `expiresAt`, `isVerified`). `Round` becomes a union on
  `kind: 'question' | 'tidbit'`, sharing `chat`, `draft`, `isThinking`
  and `issue`.
- **A new `hooks/tidbits.ts`** for the feeds, research, checks and queue,
  so `register.tsx` doesn't grow by another 400 lines. `register.tsx`
  keeps the pane and picks which kind of round to start.
- **`askClaude`** takes `{ tools, cwd, schema?, budget }` and returns
  `{ text, data?, cost }`.
- **`ui.render`** gets a tidbit branch that reuses the chat and issue
  boxes.
- **Tests** in `tests/quiz.test.tsx`: CHANGELOG splitting and the cursor,
  the quote check against a stubbed fetch, expiry, dedupe, and the
  reaction-to-weight update.

## Decisions

1. **Mode**: a random mix. Each new round is a quiz question or a tidbit at
   random (about 1 in 3 tidbits, when one is ready). There's no mode key
   or setting.
2. **Model**: Sonnet by default for everything tidbit-related.
3. **Budget**: no daily cap; only a per-call `--max-budget-usd` guard.
4. **Sources**: lane 1 is Claude Code only (the CHANGELOG). Lane 2 still
   researches general techniques on the open web.
5. **No shared feed**: research runs locally in the plugin.

## To check before building

1. ~~Can a headless `claude -p` use WebSearch and WebFetch?~~ Yes, with
   `--allowedTools`, and with no permission denials.
2. ~~Does `--json-schema` work with `--output-format json`?~~ Yes, the
   reply has `structured_output` and `total_cost_usd`.
3. ~~Is the raw CHANGELOG URL public?~~ Yes, see lane 1.
4. ~~Does the GitHub releases API give dates for these versions?~~ Yes:
   `published_at` per release, tagged `v2.1.306` where the CHANGELOG says
   `2.1.306`. A version it doesn't list falls back to the date the plugin
   first saw it.
5. Can `$.http.fetch` reach github.com and Anthropic's sites from inside
   the plugin, and does it follow redirects (docs.claude.com redirects to
   code.claude.com)?
6. How often do real sources fail the quote check because they're
   rendered by JavaScript? If it's most of them, verify through a WebFetch
   child instead.
7. ~~Parse the 1 MB CHANGELOG every day, or skip it when nothing
   changed?~~ raw.githubusercontent.com serves an ETag, so the plugin
   sends `If-None-Match` and a 304 skips it. The CHANGELOG is never kept
   in `$.store`.
