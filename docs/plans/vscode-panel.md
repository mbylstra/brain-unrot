# Plan: Brain Unrot as a VS Code extension

Status: experimental. Notes come from two claude.ai design chats (Oct 2026), revised 2026-10-23.

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

  Pull out a shared core later, if the experiment works out.
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
  ├─ events      → start a round, open the panel, queue the read file, "Claude is done"
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
| `$.store` | `context.globalState` (global keys `quiz:prefs` and `quiz:weights`). Per-repo keys (`queue:<root>`, `answered:<root>`, `skill:<root>`) use the same key names, also in `globalState`. |
| `$.session.root` | The workspace folder that matches the event's `cwd` (or the first folder when there's no event) |
| `$.process.run` | `child_process.spawn` with a timeout |
| `$.fs.*` | `vscode.workspace.fs` / `node:fs/promises` |
| `$.clock.every` | `setInterval`, cleared on deactivate |
| `$.http.fetch` | global `fetch` |
| `debug()` → `.debug.log` | An output channel ("Brain Unrot") and the same last-200-lines file in `context.logUri`, so Claude can still read it |

The UI parts of `$` (`ui.open`, `ui.focus`, `ui.resolve`, `atom`/`update`) are replaced by the panel. They don't belong in the `Host` interface.

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

- "the user submitted a prompt" (this opens the panel and starts a round)
- "Claude read file X" (this queues questions about that file)
- "Claude finished" (this shows the banner)

The bridge is a minimal Claude Code plugin made of plain command hooks:

- `UserPromptSubmit`, `PostToolUse` (matcher `Read`) and `Stop` each append `{ event, cwd, session_id, file?, at }` to `~/.brain-unrot/events.jsonl`.
- The hooks exit straight away, never block the prompt and print nothing.
- They do nothing when `BRAIN_UNROT_CHILD` is set.

The bridge is published as a second entry (`brain-unrot-bridge`) in `.claude-plugin/marketplace.json`, with its source in `vscode/bridge`. It holds no quiz logic.

Hook commands run from a plugin, so they fire the same way in the CLI and in Claude's VS Code extension.

The extension watches the file and remembers the byte offset it last read up to. It truncates the file at startup and whenever it grows past a size limit. Alternatives, in order:

1. Localhost endpoint (the hook runs `curl`). Use this only if a two-way channel turns out to be needed.
2. URI handler (`code --open-url`). VS Code may ask the user to confirm the first time, so this is a fallback only.

**Without the bridge** the extension still works, in a reduced form:

- The `Brain Unrot: Show Quiz` command and a status bar item open the panel.
- For the file to ask about, it uses recently edited files (`onDidSaveTextDocument` and a filesystem watcher on the workspace) instead of the files Claude read.
- There's no auto-open and no "done" banner.

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
- **Done banner:** a "Claude is done" banner from the `Stop` event, with an optional notification. It tells the user to go back to the agent.

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
   - "Claude is done" banner, code highlighting, packaging as a `.vsix` (`vsce package`, then `code --install-extension`).

After phase 3 it's usable day to day. Compare it with the CLI pane before going further.

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

- There are two copies of the quiz logic until (and unless) a shared core is pulled out. Fixes made to `plugin/` have to be carried across by hand.
- It only works in VS Code and its forks. Terminal-only users keep the CLI plugin.
- Auto-open still depends on Claude Code hooks (the bridge). Without them, the panel is opened by hand.

## Open questions

- Should the bridge live in this marketplace as `brain-unrot-bridge`? Or should the extension offer to write the three hooks into the user's `~/.claude/settings.json`, which avoids a plugin but edits the user's settings?
- Is `globalState` enough, or should the store be a JSON file so it can be inspected and moved?
- If the experiment works out: do we pull out a shared core that both builds import, or retire the CLI pane?
- Does the "Claude is done" banner need a notification too, or is the panel enough?
