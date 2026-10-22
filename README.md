# Brain Unrot

A Claude Code plugin that gives you something useful to do while Claude
works: a quiz about the codebase you're working in.

Every time you submit a prompt, a pane opens to the right of the chat with
a multiple-choice question about your repo. Questions are written by Claude
from the files it's reading for your task, so you learn the parts of the
code that are changing instead of approving work you don't understand.

> **Alpha.** This is early, and it has never been tested on anything other
> than my own machine. Expect rough edges, and things to change.

## Install

Add this repo as a marketplace, then install the plugin into a project:

```sh
claude plugin marketplace add mbylstra/brain-unrot
claude plugin install brain-unrot@brain-unrot --scope local
```

`--scope local` turns it on for the current project only. Run
`/reload-plugins` in an open session to pick it up.

To work on the plugin itself, add your clone as the marketplace instead
(`claude plugin marketplace add ./path/to/brain-unrot`). Every project it's
installed in then runs whatever branch is checked out, and
`/reload-plugins` picks up edits.

## Using it

The pane never takes the keyboard while you're typing to Claude. Click it,
or press ctrl+x then Tab, to answer. Esc goes back to the chat. A green
border means the pane is focused.

| Key | What it does |
| --- | --- |
| 1–4 | Answer |
| 5 | "Absolutely no idea": shows the answer |
| 6 | Ask a clarifying question. Claude discusses it without giving the answer away |
| 7 | Suggest an improvement or file a bug |
| n | Next question |
| s | Skip this question. It isn't asked again |

After you answer, the pane shows the right answer, a one-line explanation
and the file the question came from.

**More about a file.** Half the time, moving on from a question about a
file (Next after answering, or skipping) asks whether you'd like more
questions about it: 1 for yes, 2 for no. Yes puts that file's questions
first, and Claude writes more if only a few are ready. No sends its
questions to the back of the queue.

**Difficulty** goes from 1 to 5 and starts at 1. Three right in a row moves
it up one; a wrong answer moves it down half a step, and "no idea" moves it
down one. Questions answered right or skipped aren't asked again. Ones answered wrong
come back later.

**Filing issues.** Questions often expose a confusing name or a bug. Press
7, describe it, and Claude rewrites your note as an issue in
`docs/issues/todo/<date>-<slug>.md` in your repo, with the question
attached.

## How questions are made

The plugin runs the `claude` CLI in the background with Haiku, from your
repo root:

- When Claude reads a file for your task, it asks for 2 questions about
  that file.
- When fewer than 5 questions are ready at your difficulty, it asks for 4
  about the repo as a whole.
- When fewer than 2 general programming questions are ready, it asks
  Sonnet for 3. These are about concepts, trade-offs and best practices
  (frontend, backend, security, infrastructure, architecture), leaning
  towards the languages and frameworks your repo uses, never about syntax.
  Sonnet glances at a few manifests to see what the repo is built with.
  About 3 in 10 questions shown are these.

The question-writing Claude can only read files (`Read`, `Grep`, `Glob`)
and run `git log`, `git show` and `git blame` (general programming
questions get no `git` either). These calls use your Claude
account like any other, so they count towards your usage.

Until generated questions are ready, the pane shows a few hand-written
starter questions from `plugin/hooks/seeds.ts`.

## Where things are stored

- Questions, your difficulty and the questions you've answered right are
  kept per repo in the plugin's store, not in your repo.
- Filed issues go to `docs/issues/todo/` in your repo.
- `plugin/.debug.log` records what the pane did, including each
  generation and its result. It's gitignored.

## Development

```
plugin/
  hooks/register.tsx   the pane, question generation and storage
  hooks/seeds.ts       the starter questions
  types/index.d.ts     shared types
  tests/quiz.test.tsx  tests
docs/
  plans/               design notes and ideas
  issues/              issues filed from the quiz (todo/ and done/)
```

Run the tests with:

```sh
claude plugin test plugin
```

What's planned next is in [docs/plans/quiz-ideas.md](docs/plans/quiz-ideas.md)
and [docs/plans/did-you-know.md](docs/plans/did-you-know.md), a mode that
shows short, up-to-date tips on coding with LLMs.
