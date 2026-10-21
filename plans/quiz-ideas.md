# Quiz ideas

## Context

**Brain Unrot** gives you something useful to do while you wait for Claude
Code to finish a task: a quiz that helps you learn the codebase you're
working in. It opens by itself every time you submit a prompt, so you
never have to remember to start it.

How it works today:

- It's a Claude Code plugin in `plugin/`. It's installed per project from
  the local marketplace at the repo root
  (`claude plugin install brain-unrot@brain-unrot --scope local`), and
  `/reload-plugins` picks up edits.
- A `prompt.submit` hook starts a new round and opens a pane docked to the
  right of the chat (`hooks/register.tsx`).
- The pane never takes the keyboard. You click it (or press ctrl+x, then
  Tab) to answer, and Esc returns to the chat. A green or grey border shows
  whether it's focused.
- Right now the "quiz" is a placeholder: guess a number from 1 to 4.
- The plugin writes `plugin/.debug.log` (gitignored) so Claude can see what
  the pane did.

## Ideas

Ideas for what the pane asks while Claude works. A round might last 10
seconds or several minutes, and every answer is a click.

### First to build

1. **Static question bank** so there's always something to show instantly.
2. **Quiz on Claude's diff** (see *Specific lines of code*).
3. **Predict Claude's next move** (see *Using LLMs effectively*).

The last two are the most useful, only this plugin could do them, and both
run on events the plugin already gets.

### General programming knowledge

- **Questions on the repo's stack.** Look at `package.json`, `Cargo.toml`
  and so on to see what the project uses, then ask about those tools, e.g.
  "What does `satisfies` do in TS?"
- **Questions on the prompt's topic.** If the prompt mentions caching, ask
  about cache invalidation. If it says "race condition", ask what a mutex
  guarantees.
- **Spot the bug.** A 5–10 line snippet with one classic mistake (an
  off-by-one, a closure capturing a loop variable, a missing `await`). You
  pick the buggy line.
- **Big-O at a glance.** Show a snippet and pick its complexity.
- **Shell and git one-liners.** "Which flag makes `grep` print only
  filenames?" Short enough for a 10-second wait.
- **A static question bank as the baseline.** It costs nothing, the first
  question appears instantly, and the answers are always right. Generated
  questions can be layered on top.

### Overall architecture

- **Where does it live?** "The code that handles X is in…" with 4
  directory paths to choose from.
- **Who calls this?** Build a small call graph with grep or LSP, then ask
  which of 4 functions calls `foo`.
- **Dependency direction.** "Does `hooks/` import from `ui/`, the other way
  round, or neither?"
- **Trace the flow.** Show 4–5 steps of a request or event path in random
  order and have you put them in order.
- **Fog-of-war map.** A tree of the repo that fills in as you answer
  questions about each area. It shows which parts you've never looked at.
- **Git history questions.** "Which file changed most this month?", "What
  was the last commit to touch this module about?"

### Specific lines of code

- **Questions about the files Claude is touching.** Watch `tool.call`
  events for files Claude reads or edits, and have a small model (Haiku)
  write a multiple-choice question about one of them, e.g. "What does
  `parseConfig` return when the file is missing?"
- **Fill in the blank.** Take a function Claude just read, hide one line,
  and offer 4 candidates for it.
- **Name the function.** Show the body and pick the real name from 4.
- **Predict the output.** "`parseConfig({})` returns…". The answer could be
  checked by actually running small pure functions.
- **What does this regex match?** Or this SQL, or this tricky conditional.
- **What's the type of `x` here?** Good for TS and Rust codebases.
- **Predict the change.** After Claude edits a file, show the function name
  and ask what you think changed and why, then reveal the diff.
- **Quiz on Claude's diff.** After an edit, ask about the change itself:
  "Why did Claude add this null check?", "Which caller is affected?" This
  works directly against approving changes you don't understand.

### Using LLMs effectively

- **Predict Claude's next move.** "Will Claude read `a.ts` or `b.ts`
  first?", "Will it run tests before finishing?" The pane scores your
  guesses live against the actual `tool.call` events.
- **Critique your own prompt.** Show the prompt you just submitted and ask
  which change would most improve it: more context, a clear success
  criterion, smaller scope, or naming the files. Haiku picks the answer.
- **Claude Code features.** Hooks, plan mode, `/clear` vs `/compact`,
  subagents, skills, keybindings. To keep questions current, fetch the
  changelog or docs when the session starts and generate "what's new"
  questions from them.
- **Model and cost judgment.** "For this task, would Haiku, Sonnet or Opus
  be the right choice?", "Roughly how many tokens is this file?", "When
  should you start a fresh session?"
- **Spot the hallucination.** Show 4 claims about the codebase, one of them
  false.

### Mechanics that apply to all of them

- **Pre-generate in the background.** Claude might finish in 10 seconds, so
  keep a few questions queued and ready to show instantly.
- **Spaced repetition per project.** Bring back questions you got wrong in
  later rounds.
- **Every answer reveals `file:line` and a one-line explanation**, so you
  learn something even when you guess wrong.
- **Let you flag bad questions.** Generated questions will sometimes be
  wrong; flags show which generators are worth keeping.
- **End-of-round summary when Claude finishes**, e.g. "3/4 — you've now
  seen 60% of `plugin/`".

## Adaptive difficulty

Start with extremely easy questions and make them harder based on how the
user does: push their comfort level, but not too fast.

### Storage

The plugin API has `$.store`: a key-value store of JSON values that each
plugin gets for itself. It lives in a JSON file under the user's Claude
Code config directory, survives sessions and hot reloads, and is capped at
4 MiB in total. It's per user, not per project, so split it with key
prefixes:

| Kind | Key | Example |
|---|---|---|
| Global skills | `profile` | TS, git, shell, using LLMs |
| Codebase knowledge | `project:<hash of repo root>` | each top-level area: `plugin/hooks`, `plugin/ui` |
| Review queue | inside each of the above | IDs of missed questions, plus when each is due |

Store running totals rather than full answer histories, so the 4 MiB cap is
never a concern:

```json
{ "topics": { "ts": { "level": 3.5, "streak": 2, "seen": 41, "correct": 30, "lastSeen": "2026-10-21" } } }
```

### How the difficulty moves

- **Start with a staircase.** Every question has a level from 1 to 10.
  3 right in a row moves you up one level; 1 wrong moves you down half a
  level. This is the classic 3-up/1-down staircase from psychophysics. It
  settles where you get about 80% right and needs 2 numbers per topic.
- **Move to Elo later if needed.** Give each question a rating and each
  topic you a rating, then pick questions you'd get right about 75–85% of
  the time, with a capped K-factor so it doesn't move too fast. Hold off
  until the staircase actually feels too coarse.

### Getting questions at the right level

- **A level rubric for each category.** For example, in architecture: L1 is
  "Which folder holds the tests?", L5 is "Which module owns X?", and L9 is
  "What breaks if Y is removed?"
- **Static questions carry their level in the bank.** Generated questions
  come from asking Haiku for "a level-N question" using the rubric.
- **Pick the topic with an explore/exploit mix.** Mostly topics related to
  what Claude is touching right now, sometimes one you haven't seen in a
  while.

### Details worth getting right

- **Discount lucky guesses.** With 4 options, a random click is right 25% of
  the time. An "I don't know" button keeps guesses from inflating your level.
- **"Too easy" and "too hard" buttons**, applied as an immediate ±1 level.
- **Knowledge decays over time.** Global levels drift down slowly when a
  topic goes unused. Codebase levels for an area drop when commits touch
  that area (diff `git log` since `lastSeen`).
- **Bad questions don't count.** A flagged question doesn't move your level.
- **Spaced repetition on top.** Missed questions come back after 1, 3, then
  7 rounds (Leitner boxes), whatever your current level.
- **Show your level in the pane**, e.g. "TS ▮▮▮▯▯". It's motivating and makes
  it obvious when the adaptation is off.

### First to build

The staircase, the `profile` / `project:` split, and the "I don't know"
button.

## Question generation and caching

Questions are generated by an LLM (not necessarily the one running the
session), and they must appear instantly, so they're generated ahead of
time and cached.

### What the plugin API gives us

- **`$.model.complete({ model: "haiku", prompt })`** runs one text
  completion through the session's own API client, so no extra key is
  needed. It accepts any model alias or ID.
- **`$.http.fetch`** can call other providers: OpenAI, Gemini, or a local
  Ollama.
- **`$.process`** can run a CLI generator instead (`codex`, `llm`,
  `ollama run`).
- **`$.store`** holds the cache, and **`$.clock.after` / `every`** can
  schedule refills.

### Design: a stocked pantry plus a fast lane

1. **The pantry is long-lived questions**, stored in `$.store` and grouped
   by `(topic, level)`. Keep about 3 ready questions for each bucket at the
   user's current level, one below and one above, so the next question is
   ready wherever the staircase moves. This covers general knowledge,
   architecture and LLM-usage questions, which are still good next session.
2. **The fast lane is questions about what Claude is doing right now**:
   diff questions, "files Claude is touching" and the like. Start
   generating on `tool.call` events while Claude works. If a fast-lane
   question is ready, show it; if not, show a pantry question so the pane
   is never empty.
3. **A seed bank ships with the plugin.** About 50 hand-written easy
   questions make the very first run instant too, before any generation
   has happened.

### Refilling

- **When it runs:** after each answer (top up the bucket just used), at
  session start, and when Claude finishes a turn.
- **Ask for several questions per call.** Request 5 questions in one JSON
  reply, so the rubric and file context are paid for once.
- **One request at a time, with a daily cost budget.** `$.model.complete`
  returns usage to track cost against. Generation runs on the user's own
  quota, so it shouldn't compete with Claude's requests.
- **Feed the generator recent question stems** so it avoids repeats, and
  dedupe by a hash of the question text.

### Checking questions before they reach the pantry

Generated questions are cheap, but wrong ones destroy trust.

- **Validate the JSON:** exactly 4 options and exactly 1 answer.
- **Shuffle the options locally.** LLMs put the right answer in the same
  position far too often.
- **Check quoted code.** For codebase questions, confirm any quoted snippet
  appears verbatim in the file.
- **Optional cross-check:** a second model answers the question blind; if
  it disagrees with the key, drop the question. Most worth it for higher
  levels.

### Going stale

- **Codebase questions** store the source file's path and git blob hash.
  When serving, drop any whose file has changed.
- **LLM and Claude Code questions** get a time-to-live of a few weeks,
  because that knowledge goes out of date.

### Swapping providers

Hide generation behind one interface, `generate(spec) → Question[]`. Ship a
Haiku implementation first, add HTTP and CLI implementations later, and
pick the provider in plugin settings.

### To check before building

1. **Can async work outlive the hook that started it?** Hooks run on a
   budget (`next.budget.remainingMs`). Confirm a refill started from
   `prompt.submit` or `tool.call` keeps running after the hook returns, or
   else schedule it with `$.clock.after`. The `plugin-authoring` skill
   should answer this.
2. **`$.model.fork` is tempting for the fast lane.** It reuses the main
   conversation's cached prefix, so it already knows what Claude is doing,
   but it runs on the main thread's model (Opus), not Haiku. Try it for
   diff questions only once costs are measured.
