# CLAUDE.md

Brain Unrot is a Claude Code plugin (a "mod") that shows a quiz pane about the user's repo while Claude works. The plugin lives in `plugin/`. The repo root is also its marketplace (`.claude-plugin/marketplace.json` points at `./plugin`).

## Commands

- Run the tests: `claude plugin test plugin`. This runs every `*.test.ts(x)` under `plugin/`. There is no flag to pick out a single test, so to run one, temporarily put it in its own test file.
- Validate the manifests: `claude plugin validate plugin`
- To try a change for real: the user's marketplace is this clone, so `/reload-plugins` in an open session picks up edits. Every project that has the plugin installed runs whatever branch is checked out here.

Tests import their kit from `claude-code/testing`. The `claude-code` types under `plugin/.claude-plugin/types/` are supplied by Claude Code and gitignored, so don't edit them.

## Architecture

`plugin/hooks/hooks.json` loads one module, `register.tsx`, which registers engine hooks:

- `session.start` starts timers (`$.clock.every`) for question generation, the clarifying-question chat, issue filing and tidbit research. Background work runs on timers so it can outlive the hook that queued it.
- `tool.call` on `Read` queues the file Claude just read, so questions get written about it.
- `prompt.submit` starts a new round and opens the pane. It must never hold up the prompt or take the keyboard focus.
- `ui.render` draws the pane. UI state lives in `atom`s and is changed with `update`.

All model work goes through `askClaude` in `hooks/claude.ts`, which spawns `claude -p` with `--permission-mode dontAsk`, user settings only, hooks disabled and a strict MCP config. The child process would load this plugin too, so `askClaude` sets `BRAIN_UNROT_CHILD` (`DISABLE_PLUGIN_ENV_VAR`), and `register.tsx` goes quiet when it sees it. Each kind of job has its own tool and permission set (`CODE`, `CONCEPT`, `EDIT` in `register.tsx`). Keep these minimal, because they decide what the background Claude can do in the user's repo.

Models: Haiku writes codebase questions. Sonnet writes general-programming ("concept") questions, and also does all tidbit research (`hooks/tidbits.ts`), because Haiku took the first search result at face value.

Persistence is `$.store`. Per-repo keys are suffixed with the session root (`queue:<root>`, `answered:<root>`, `skill:<root>`), and preferences/weights are global (`quiz:prefs`, `quiz:weights`). When renaming a stored field or key, keep reading the old name: `loadQueue`/`loadSkill` still accept `pantry:`, `level` and `file` from earlier renames.

Debugging: `debug()` writes the last 200 lines to `.debug.log` in `$.plugin.root`. For an installed copy that's under `~/.claude/plugins/cache/brain-unrot/brain-unrot/<version>/`. You can't see the pane or the transcript it runs in, so read this log instead.

## Glossary

- **round**: one thing shown in the pane, either a question or a tidbit
- **queue**: generated questions waiting to be shown (formerly "pantry")
- **seeds**: hand-written warm-up questions and tidbits in `hooks/seeds.ts`, shown until generated ones are ready
- **concept question**: a general programming question, not about this repo
- **tidbit**: a short "did you know" tip about coding with LLMs (see `docs/plans/did-you-know.md`)
- **difficulty**: 1–5 (formerly "level"). **skill** is the user's current difficulty plus their streak

## Conventions

- Use full-word names, not abbreviations (`DISABLE_PLUGIN_ENV_VAR`, `sourceFile`), including in prompt text shown to users.
- Commit subjects are a single plain sentence in the imperative, with no type prefix (e.g. "Ask whether you'd like more questions about a file").
- Issues filed from the quiz live in `docs/issues/todo/<date>-<slug>.md`. Move an issue to `docs/issues/done/` once it's fixed.
