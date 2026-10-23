# Brain Unrot

A VS Code extension that gives you something useful to do while Claude
works: a quiz about the codebase you're working in.

Every time you send Claude a prompt, a panel opens beside the editor with
a multiple-choice question about your repo. Questions are written by Claude
from the files it's reading for your task, so you learn the parts of the
code that are changing instead of approving work you don't understand.

It works with Claude Code in the integrated terminal and with Claude's VS
Code extension.

> **Alpha.** This is early, and it has never been tested on anything other
> than my own machine. Expect rough edges, and things to change.

Brain Unrot started as a Claude Code plugin that drew the quiz in a
terminal pane. That version is kept at the `cli-plugin` tag.

## Install

Build and install the extension (there's no Marketplace release yet):

```sh
cd vscode
npm install
npm run package
code --install-extension brain-unrot-0.1.0.vsix
```

Then run **Developer: Reload Window** in any VS Code window that's already
open.

That's enough: the extension follows Claude Code's session transcripts to
see your prompts and the files Claude reads. That format isn't documented,
though, so for something sturdier also install the bridge, a tiny Claude
Code plugin that reports the same events through hooks:

```sh
claude plugin marketplace add mbylstra/brain-unrot
claude plugin install brain-unrot-bridge@brain-unrot
```

If you used the old CLI plugin, uninstall it (`/plugin`), or you'll get two
quizzes.

## Using it

The panel never takes the keyboard while you're typing to Claude. Click it
to answer, or use the keys:

| Key | What it does |
| --- | --- |
| 1–4 | Answer |
| 5 | "Absolutely no idea": shows the answer |
| 6 | Ask a clarifying question. Claude discusses it without giving the answer away |
| 7 | Suggest an improvement or file a bug |
| n | Next question |
| s | Skip this question. It isn't asked again |

After you answer, the panel shows the right answer, an explanation and the
file the question came from.

**Claude is ready.** When Claude finishes its turn, the question you're on
isn't interrupted. Once you're done with it, the panel says Claude is ready
instead of showing another question: switch back, or press n to keep going.

**More about a file.** Half the time, moving on from a question about a
file asks whether you'd like more questions about it. Yes puts that file's
questions first, and Claude writes more if only a few are ready. No sends
its questions to the back of the queue.

**Difficulty** goes from 1 to 5 and starts at 1. Three right in a row moves
it up one; a wrong answer moves it down half a step, and "no idea" moves it
down one. Questions answered right or skipped aren't asked again. Ones
answered wrong come back later.

**Did you know?** Now and then the panel shows a short, up-to-date tip on
coding with LLMs instead of a question, researched from the Claude Code
changelog and the web.

**Filing issues.** Questions often expose a confusing name or a bug. Press
7, describe it, and Claude rewrites your note as an issue in
`docs/issues/todo/<date>-<slug>.md` in your repo, with the question
attached.

## How questions are made

The extension runs the `claude` CLI in the background, from your repo root.
It starts only in a project where you've sent Claude a prompt or opened the
quiz:

- When Claude reads a file for your task, Haiku writes 2 questions about
  that file.
- When fewer than 5 questions are ready at your difficulty, Haiku writes 4
  about the repo as a whole.
- When the project has instruction files for coding agents (`CLAUDE.md`,
  `AGENTS.md`, skills), Haiku writes questions about what they tell the
  agent to do.
- When fewer than 2 general programming questions are ready, Sonnet writes
  3, about concepts, trade-offs and best practices, leaning towards the
  languages and frameworks your repo uses.

The question-writing Claude can only read files (`Read`, `Grep`, `Glob`)
and run `git log`, `git show` and `git blame`. These calls use your Claude
account like any other, so they count towards your usage.

If VS Code can't find `claude` (it may lack your shell's `PATH` when opened
from the Dock), set `brainUnrot.claudePath`.

## Where things are stored

Everything is plain JSON you can read, edit or delete.

- `<repo>/.brain-unrot/`: this repo's questions, your difficulty, and the
  questions you've answered. It has its own `.gitignore`, so it's never
  committed.
- `~/.brain-unrot/`: general programming questions (any project can use
  them), tidbits, your preferences, and the bridge's events.
- Filed issues go to `docs/issues/todo/` in your repo.
- What the extension did is in the **Brain Unrot** output channel.

## Development

```
vscode/
  src/extension.ts   activation, windows and folders, timers, events
  src/core/          the quiz: state, prompts, generation, tidbits, seeds
  src/events.ts      the bridge and transcript watchers
  src/panel.ts       the webview panel
  webview/           the panel's UI
  bridge/            the brain-unrot-bridge Claude Code plugin
  test/              tests
docs/
  plans/             design notes and ideas
  issues/            issues filed from the quiz (todo/ and done/)
```

Run the tests with `npm test` in `vscode/`. More is in
[CLAUDE.md](CLAUDE.md) and [vscode/README.md](vscode/README.md).

The design of the extension is in
[docs/plans/vscode-panel.md](docs/plans/vscode-panel.md). What's planned
next is in [docs/plans/quiz-ideas.md](docs/plans/quiz-ideas.md).
