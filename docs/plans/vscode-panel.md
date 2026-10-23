# Plan: Brain Unrot as a VS Code extension

Status: done. Built on 2026-10-23, and the panel won: the CLI pane in `plugin/` was removed the same day and is kept at the `cli-plugin` tag. Notes come from two claude.ai design chats (Oct 2026), revised 2026-10-23.

## Goal

Rebuild the whole app as a VS Code extension with a webview panel. **The extension is the app.** It owns:

- the UI
- the state
- question generation
- the chat
- issue filing
- tidbits

Claude Code plugin hooks are at most an implementation detail. They let the extension hear what Claude is doing. They aren't a "Claude plugin feature".

The existing CLI plugin in `plugin/` stays as it is and keeps shipping. The extension is a separate, experimental build that sits beside it.

## Why move off the CLI pane

The current plugin draws the quiz in a terminal pane next to Claude Code, so the UI is limited to text. A rich HTML interface would allow:

- Better question rendering (code highlighting, diagrams, images).
- Content from other learning platforms, rendered in one place.
- Room for new modes (for example the "did you know" tips in `did-you-know.md`).

The hard constraint is that **the panel must open automatically**. Today the pane appears on every prompt, and that's what reminds people it exists. A panel that has to be opened by hand won't get used.

## Isolation from the existing plugin

- All new code goes in a new top-level directory, `vscode/`. Nothing under `plugin/` changes.
- This rule applies on every branch. Every project with the plugin installed runs whatever branch this clone has checked out, so a change to `plugin/` reaches real users at once.
- This also means **no shared code is pulled out of `register.tsx` for now**. The extension copies what it needs and adapts it:
  - the prompts and parsers
  - `seeds.ts`
  - `tidbits.ts`
  - `askClaude`

  There's no plan to share code between the two builds. If the panel turns out better (not yet tested), the CLI pane is retired. If it doesn't, the extension is dropped. Either way, only one copy is left.
- The marketplace may gain a new entry for the bridge (see below). Adding an entry doesn't replace `./plugin`.
- `claude plugin test plugin` only scans `plugin/`, so the extension's tests don't touch it, and it needs its own test runner.
- **State isn't shared.** The extension can't read the plugin's `$.store`. If both run in one project, every question gets generated twice and paid for twice, and two quizzes show up. In a project that tries the panel, disable the CLI plugin (`/plugin` → disable `brain-unrot` for that project).

## Options considered for the UI surface

- **MCP Apps** (a `ui://` resource rendered inline in the chat). These render in the Claude desktop app, claude.ai and VS Code Copilot Chat, but **not in Claude Code** (neither the CLI nor, as far as we could find, Claude's VS Code extension). Not usable today. Keep the UI portable so it could be served this way later.
- **Local web server + external browser.** Rejected. It sits outside the editor, so nobody will look at it.
- **Simple Browser.** Rejected. Nothing outside VS Code can reliably make it open automatically.
- **VS Code extension with a `WebviewPanel`** (chosen).

## Architecture

```
Claude Code (CLI in the integrated terminal, or Claude's VS Code extension)
  └─ brain-unrot-bridge (optional, tiny): UserPromptSubmit / PostToolUse(Read) / Stop
       └─ appends one JSON line per event to ~/.brain-unrot/events.jsonl
                                     │ (watched)
VS Code extension (vscode/)          ▼
  ├─ events      → start a round, open the panel, queue the read file, "Claude is ready"
  ├─ core        → queue, skill, seeds, rounds, prompts, parsers (ported from register.tsx)
  ├─ jobs        → timers for generation, chat, issue filing, tidbit research
  ├─ askClaude   → spawns `claude -p` (same flags and permission sets as today)
  ├─ host        → store, fs, process, clock, http, log (VS Code / Node versions of `$`)
  └─ WebviewPanel (ViewColumn.Beside, preserveFocus)
        ↑ state snapshots      ↓ actions (answer, chat, file issue, prefer…)
      quiz UI (one self-contained HTML/JS bundle)
```

### Layout of `vscode/`

```
vscode/
  package.json        extension manifest (activation: onStartupFinished, commands, settings)
  src/extension.ts    activate(): build the host, start jobs, watch events, own the panel
  src/host.ts         Host interface plus its VS Code implementation
  src/core/           code ported from plugin/hooks (register.tsx logic, seeds, tidbits, claude.ts)
  src/panel.ts        WebviewPanel lifecycle and the message protocol
  webview/            quiz UI, bundled with esbuild into one file
  bridge/             the tiny Claude Code plugin that forwards events (see below)
  test/               unit tests for core (vitest, plain Node, no VS Code needed)
```

### Host adapter

The ported logic uses a small part of `$`:

- `store.get`/`set`
- `fs.exists`/`list`/`stat`/`write`
- `process.run`
- `clock.now`/`every`
- `http.fetch`
- `env.get`
- `session.root`
- `plugin.root`

Define a `Host` interface with that shape, so the ported functions change as little as possible. The VS Code implementation:

| `$` today | Extension |
|---|---|
| `$.store` | JSON files: project data in the project, general data in `~/.brain-unrot/` (see "Storage") |
| `$.session.root` | The workspace folder that matches the event's `cwd` (or the first folder when there's no event) |
| `$.process.run` | `child_process.spawn` with a timeout |
| `$.fs.*` | `vscode.workspace.fs` / `node:fs/promises` |
| `$.clock.every` | `setInterval`, cleared on deactivate |
| `$.http.fetch` | global `fetch` |
| `debug()` → `.debug.log` | An output channel ("Brain Unrot") and the same last-200-lines file in `context.logUri`, so Claude can still read it |

The UI parts of `$` (`ui.open`, `ui.focus`, `ui.resolve`, `atom`/`update`) are replaced by the panel. They don't belong in the `Host` interface.

### Storage

Data about a project lives in that project. General data lives on the user's machine. Everything is plain JSON, so the user or Claude can read it, edit it and delete it.

| Where | What |
|---|---|
| `<project>/.brain-unrot/` | Codebase and instruction questions (the queue), the `answered` list for them, and skill (difficulty and streak) for this project |
| `~/.brain-unrot/` | Concept questions, tidbits, and the `answered` list for both; quiz preferences and category weights; `events.jsonl` from the bridge |

- Concept questions are still written with the current project as context, which picks the topics. They're general knowledge, though, so they go in the global store, tagged with the project they came from. Any project can then use them.
- The extension creates `<project>/.brain-unrot/.gitignore` containing `*`. The folder then stays out of git without touching the project's own `.gitignore`. The questions and progress are personal, so they're never committed.
- Writes are atomic (write a temp file, then rename it). Each change reads the file fresh first, because several VS Code windows can write to `~/.brain-unrot/` at once.
- Unlike VS Code's `globalState`, both places are shared by VS Code, Cursor and other forks.
- The new layout doesn't migrate the plugin's `$.store` data. The extension starts fresh.

### Background Claude

Copy `askClaude` as it is. Keep:

- `claude -p` with `--permission-mode dontAsk`
- user settings only
- `disableAllHooks`
- `--strict-mcp-config`
- `--no-session-persistence`
- `BRAIN_UNROT_CHILD` set on the child

Copy the `CODE`, `CONCEPT`, `INSTRUCTIONS` and `EDIT` tool and permission sets unchanged. They decide what the background Claude can do in the user's repo, so they don't get looser in the move.

Using the CLI keeps the user's existing Claude login and billing. Calling the API directly would need a key.

**PATH:** VS Code started from the macOS Dock often lacks the user's shell PATH, so `claude` isn't found. Add a `brainUnrot.claudePath` setting. When it's empty, resolve the path once through a login shell (`$SHELL -lc 'command -v claude'`).

### Events and the bridge

VS Code by itself can't see:

- "the user submitted a prompt" (this opens the panel and starts a round). **This one matters most.** The auto-open depends on it.
- "Claude read file X" (this queues questions about that file)
- "Claude finished" (after the current round, this shows "Claude is ready" in place of the next question)

The bridge gets these from Claude Code hooks. Hooks could also go straight into a settings file, but a plugin is the nicer way to give them to users. It's one `/plugin` install, it updates like any plugin, it can be switched on or off per project, and nobody's `settings.json` gets edited.

The bridge is a minimal Claude Code plugin made of plain command hooks:

- `UserPromptSubmit`, `PostToolUse` (matcher `Read`) and `Stop` each append `{ event, cwd, session_id, file?, at }` to `~/.brain-unrot/events.jsonl`.
- The hooks exit straight away, never block the prompt and print nothing.
- They do nothing when `BRAIN_UNROT_CHILD` is set.

The bridge is published as a second entry (`brain-unrot-bridge`) in `.claude-plugin/marketplace.json`, with its source in `vscode/bridge`. It holds no quiz logic.

Hook commands run from a plugin, so they fire the same way in the CLI and in Claude's VS Code extension.

The extension watches the file and remembers the byte offset it last read up to. It truncates the file at startup and whenever it grows past a size limit. Alternatives, in order:

1. Localhost endpoint (the hook runs `curl`). Use this only if a two-way channel turns out to be needed.
2. URI handler (`code --open-url`). VS Code may ask the user to confirm the first time, so this is a fallback only.

**Without the bridge**, the extension falls back to watching Claude Code's session transcripts. It needs nothing installed apart from the extension.

- Every session writes `~/.claude/projects/<cwd with / replaced by ->/<session-id>.jsonl`. The CLI and Claude's VS Code extension both write it. The three events show up in it as they happen:
  - a `user` entry with text content means a prompt was submitted
  - an `assistant` entry with a `tool_use` named `Read` (`input.file_path`) means Claude read a file
  - a `system` entry with subtype `turn_duration` means Claude finished its turn
- The format is internal and undocumented, so it could change in any Claude Code release. Parse it defensively, and log when a line doesn't match what's expected. When the bridge is installed, its events win.
- If neither the bridge nor the transcripts give us anything, the `Brain Unrot: Show Quiz` command and a status bar item open the panel. In that case the file to ask about comes from recently edited files (`onDidSaveTextDocument`).

### Multiple windows

Every VS Code window runs the extension and sees every event. Each window only acts on events whose `cwd` lies inside one of its `workspaceFolders`. Timers only generate for workspace folders that are open in that window.

### Panel

```ts
let panel: vscode.WebviewPanel | undefined

function showQuiz() {
  if (panel) return panel.reveal(vscode.ViewColumn.Beside, true) // preserveFocus
  panel = vscode.window.createWebviewPanel(
    'brainUnrot',
    'Brain Unrot',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [webviewDist] },
  )
  panel.onDidDispose(() => (panel = undefined))
}
```

- `preserveFocus` keeps the rule that a prompt never takes the keyboard focus away from Claude.
- If the user closes the panel, the next prompt brings it back. Maybe add a setting to stop that.
- The webview is only a view. The extension holds the state (today's `round`, `ready`, `tips`, `skill`, `notice` and `isAskingPreference` atoms). It posts a full snapshot whenever that state changes, and the webview posts actions back. The actions mirror today's key handlers: pick a choice, "no idea", next, open the chat, send a message, start or file an issue, prefer a category, more or less about a file.
- Use a strict CSP with a nonce. Any third-party content is fetched by the extension and rendered by the UI, never framed in an iframe (see below).

## What gets ported

Everything in `plugin/hooks` today:

- **Rounds:** a question or a tidbit. Seeds are shown until generated questions are ready.
- **Generation timers:**
  - codebase questions (about one file, or the whole repo) on Haiku
  - concept questions on Sonnet, with a budget cap
  - instruction questions on Haiku, re-checked every minute (`CLAUDE.md`, `AGENTS.md`, skills, agents and commands, and their `@path` imports)
- **Queue:** the per-repo queue (`QUEUE_MAX`, `QUEUE_LOW` top-ups) and the `answered` list (`ANSWERED_MAX`, `AVOID_MAX`).
- **Skill:** difficulty 1–5, plus a streak (`STREAK_UP`).
- **Preferences:** "more about this file" offers, the occasional "which kind would you like more of?" question, and the category weights.
- **Tidbits:** research on Sonnet (`tidbits.ts`).
- **Chat:** the clarifying chat about the current question.
- **Issues:** filing to `docs/issues/todo/<date>-<slug>.md` with the `EDIT` permission set.
- **Notices.**

Constants and prompt text are copied as they are, so the two builds behave the same way. They may drift later. That's acceptable for an experiment.

New in the panel:

- **Code rendering:** syntax-highlighted code in questions and explanations.
- **"Claude is ready" break:** when the `Stop` event arrives, nothing interrupts the question you're on. When that round ends, the panel shows "Claude is ready" in place of the next question. You either switch back to Claude yourself, or press a key or button to keep going with another question. The next `UserPromptSubmit` clears it. There's no notification, since Claude Code already sends one when its turn finishes. Nice to have: a small banner in the panel while you're still answering.

## Phases

1. **Scaffold.**
   - `vscode/` extension and webview bundle.
   - `Show Quiz` command.
   - Seed questions answerable in the panel.
   - Run it with F5 (Extension Development Host).
2. **Bridge and auto-open.**
   - Bridge plugin and the event watcher.
   - Open on each prompt without taking focus.
   - Window matching.
3. **Core port.**
   - `Host` adapter, `askClaude` and the queue.
   - Codebase, concept and instruction generation.
   - Skill.
   - Unit tests for core with a fake `Host`.
4. **Everything else.**
   - Chat, issue filing, tidbits, preferences and offers, notices.
5. **Panel-only features.**
   - "Claude is ready" break, code highlighting, packaging as a `.vsix` (`vsce package`, then `code --install-extension`).

After phase 3 it's usable day to day. Compare it with the CLI pane before going further.

If the panel wins, retire the CLI pane:

- Remove `plugin/` and its marketplace entry. Keep the bridge plugin.
- Rewrite CLAUDE.md to describe the extension.

## Third-party content: iframes vs APIs

Many sites refuse to be framed (`X-Frame-Options` or CSP `frame-ancestors`), especially ones with logins, such as LeetCode. A webview can't override this, so the iframe just comes up blank. Pull content through APIs and render it ourselves. Check any specific site before designing around embedding it.

Candidate sources for the general-knowledge slice (currently written by Sonnet):

| Source | Format | Fit | Notes |
|---|---|---|---|
| AnkiConnect (local Anki add-on) | Free-recall flashcards via a local HTTP API | High | Anki's FSRS scheduler handles spacing, and reviews sync to mobile. Good shared decks exist (for example the System Design Primer decks). Needs a "show answer, then self-grade" mode. |
| QuizAPI.io | Multiple-choice JSON API | Medium–high | Filter by category, tags and difficulty (easy/medium/hard/expert, which maps onto our 1–5 scale). Free for dev and non-commercial use. Quality is uneven, with some pure trivia. Check free-tier limits. |
| Codewars API | Kata metadata plus kyu rank | Low | Exercises are too heavy for a 1–4 answer pane. API docs are partly out of date. |
| Exercism problem-specifications | Open exercise specs on GitHub | Low | Full exercises, not quick questions. |
| Open Trivia DB | Free multiple-choice, no key | Low | Has a computers category, but it's shallow trivia. |

Suggested split: AnkiConnect (or QuizAPI) for general knowledge. Keep Claude-written questions for the codebase-specific part, where off-the-shelf content can't compete.

Licensing: check each source's terms before bundling content. Fetching per user at runtime is safer than shipping it.

## Reuse: keep the UI portable

Build the quiz UI as one self-contained HTML/JS bundle that talks only through the message protocol. It can then be:

- loaded into the VS Code webview, and
- served later as a `ui://` MCP App resource, so the same UI renders inline for desktop app and claude.ai users.

## Costs and trade-offs

- Until the experiment is decided, there are two copies of the quiz logic. Fixes made to `plugin/` have to be carried across by hand, so keep the experiment short.
- It only works in VS Code and its forks. Terminal-only users keep the CLI plugin.
- Reliable auto-open depends on the bridge's `UserPromptSubmit` hook. Without the bridge, auto-open relies on the transcript format, which can change without notice.
