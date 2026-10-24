# CLAUDE.md

Brain Unrot is a VS Code extension that shows a quiz about the user's repo in a panel beside the editor while Claude works. It lives in `vscode/`. The repo root is also a Claude Code marketplace with one plugin, `brain-unrot-bridge` (`vscode/bridge`), which tells the extension what Claude is doing.

It used to be a Claude Code plugin that drew the quiz in a terminal pane. That version is at the `cli-plugin` tag.

## Commands

Run these in `vscode/`:

- Install the dependencies: `npm install`
- Run the tests: `npm test` (vitest, plain Node, no VS Code needed). One file: `npx vitest run test/quiz.test.ts`, or one test: `-t '<name>'`
- Type-check: `npm run typecheck`
- Build: `npm run build` (esbuild, to `dist/`)
- Validate the bridge: `claude plugin validate vscode/bridge`, from the repo root

To try a change for real, package it and reinstall it, then run **Developer: Reload Window** in VS Code (you can't do that part; ask the user):

```sh
npm run package && code --install-extension brain-unrot-0.1.0.vsix --force
```

The user's marketplace is this clone, so the bridge runs whatever branch is checked out here, and `/reload-plugins` picks up edits to it.

## Architecture

- `src/extension.ts` activates on startup. It makes one `Quiz` per workspace folder, owns the panel, and starts each folder's timers (generation, the chat, issue filing) only once Claude or the quiz has been used there, since they spend money. One research timer runs tidbits.
- `src/core/` is the quiz logic. `quiz.ts` holds the state, the actions the panel sends, the prompts and generation. `tidbits.ts` does tidbit research, `claude.ts` has `askClaude`, `seeds.ts` the warm-up questions and tidbits.
- `src/host.ts` is the `Host` interface the core uses for storage, files, processes, the clock, HTTP and logging. `src/node-host.ts` and `src/store.ts` implement it; tests use `test/fake-host.ts`. Keep `src/core/` free of `vscode` imports.
- `src/events.ts` watches for what Claude does: a prompt (starts a round and opens the panel), a `Read` (queues the file for questions) and the end of a turn ("Claude is ready"). It reads the bridge's `~/.brain-unrot/events.jsonl`, and otherwise follows Claude Code's session transcripts in `~/.claude/projects/*/*.jsonl`. That format is internal and undocumented, so parse it defensively. A window only acts on events whose `cwd` is inside one of its workspace folders.
- `src/panel.ts` and `webview/` are the panel. The webview only draws: the extension posts a full snapshot (`Quiz.view()`) on every change, and the webview posts actions back. The webview talks only through messages, so it could be served elsewhere later. Opening the panel must never take the keyboard focus (`preserveFocus`).
- `bridge/` is a Claude Code plugin of plain command hooks (`forward.sh`). It must print nothing, never block, always exit 0, and do nothing when `BRAIN_UNROT_CHILD` is set.

All model work goes through `askClaude`, which spawns `claude -p` with `--permission-mode dontAsk`, user settings only, hooks disabled and a strict MCP config. It sets `BRAIN_UNROT_CHILD` (`DISABLE_PLUGIN_ENV_VAR`) so the bridge stays quiet in that process. Each kind of job has its own tool and permission set (`CODE`, `CONCEPT`, `INSTRUCTIONS`, `EDIT` in `quiz.ts`). Keep these minimal, because they decide what the background Claude can do in the user's repo. The `claude` path comes from the `brainUnrot.claudePath` setting, or else a login shell and the usual install locations.

Models: Haiku writes codebase and instruction questions. Sonnet writes general-programming ("concept") questions, and also does all tidbit research, because Haiku took the first search result at face value.

Persistence is plain JSON, one file per key, written atomically and read fresh each time (several windows share it):

- `<project>/.brain-unrot/` (with its own `.gitignore` of `*`): `queue` (codebase and instruction questions), `answered`, `skill`, and `logs/`: the prompt and reply of every tidbit generation, one Markdown file per call
- `~/.brain-unrot/`: `concepts` (concept questions, tagged with their `project`), `answered` (concept and seed questions), tidbits, `quiz:prefs`, `quiz:weights`, and `events.jsonl`

When renaming a stored field or key, keep reading the old name.

Debugging: the extension logs to the **Brain Unrot** output channel, and the last 200 lines go to `debug.log` in its log folder: `~/Library/Application Support/Code/logs/<session>/window<n>/exthost/mbylstra.brain-unrot/debug.log` on macOS, one per window. You can't see the panel, so read this log instead.

## Glossary

- **round**: one thing shown in the panel, either a question or a tidbit
- **queue**: generated questions waiting to be shown (formerly "pantry")
- **seeds**: hand-written warm-up questions and tidbits in `src/core/seeds.ts`, shown until generated ones are ready
- **concept question**: a general programming question, not about this repo
- **instruction question**: a question about what the project tells coding agents, in its instruction files (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `SKILL.md` under `.claude/skills` or `.agents/skills`, and `.claude/agents` and `.claude/commands`) and the files they import with `@path`. It's about the instructions as a whole, or about one file (`sourceFile`)
- **tidbit**: a short "did you know" tip about coding with LLMs (see `docs/plans/did-you-know.md`)
- **difficulty**: 1–5 (formerly "level"). **skill** is the user's current difficulty plus their streak
- **bridge**: the `brain-unrot-bridge` Claude Code plugin that forwards events to the extension
- **Claude is ready**: when Claude finishes its turn, the round you're on carries on, and the panel says so in place of the next one

## Conventions

- Use full-word names, not abbreviations (`DISABLE_PLUGIN_ENV_VAR`, `sourceFile`), including in prompt text shown to users.
- Commit subjects are a single plain sentence in the imperative, with no type prefix (e.g. "Ask whether you'd like more questions about a file").
- Issues filed from the quiz live in `docs/issues/todo/<date>-<slug>.md`. Move an issue to `docs/issues/done/` once it's fixed.
