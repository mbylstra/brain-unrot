# Brain Unrot for VS Code

The Brain Unrot quiz as a VS Code extension. It shows a panel beside the editor whenever you send Claude a prompt. The plan behind it is in [`docs/plans/vscode-panel.md`](../docs/plans/vscode-panel.md).

The extension is the whole app. It holds the state, writes the questions, and runs the chat, issue filing and tidbits. Claude Code only tells it what Claude is doing.

## Try it

```sh
cd vscode
npm install
npm run build
```

Then open `vscode/` in VS Code and press F5 (Extension Development Host). To install it for real:

```sh
npm run build && npm run package
code --install-extension brain-unrot-0.1.0.vsix
```

**If you used the old CLI plugin, uninstall it** (`/plugin`). The two don't share state, so with both on, every question gets generated twice and you get two quizzes.

## How it hears Claude

- **The bridge plugin (recommended).** Install `brain-unrot-bridge` from this marketplace with `/plugin`. Its hooks append one line per prompt, `Read` and turn end to `~/.brain-unrot/events.jsonl`. They print nothing, never block, and skip the `claude` processes the extension starts itself.
- **Without the bridge**, the extension tails Claude Code's session transcripts in `~/.claude/projects/`. That format is internal and could change in any release.
- **If neither works**, run **Brain Unrot: Show Quiz** or click the status bar item. Files you save then stand in for the files Claude read.

## Where things are kept

Everything is plain JSON, so you or Claude can read, edit or delete it.

| Where | What |
|---|---|
| `<project>/.brain-unrot/` | `queue.json` (codebase and instruction questions), `answered.json`, `skill.json`. It has its own `.gitignore` containing `*` |
| `~/.brain-unrot/` | `concepts.json` (general questions, each tagged with its project), `answered.json` for concept and seed questions, tidbits, `quiz-prefs.json`, `quiz-weights.json`, and `events.jsonl` from the bridge |

Logs are in the **Brain Unrot** output channel. The last 200 lines are also written to `debug.log` in the extension's log folder; the first line of the channel says where.

## Settings

- `brainUnrot.claudePath`: the `claude` CLI. When it's empty, it's found through your login shell, since VS Code opened from the Dock often lacks your shell's `PATH`.
- `brainUnrot.reopenOnPrompt`: open the panel again on the next prompt after you close it (on by default).

## Layout

- `src/extension.ts`: activation, one `Quiz` per workspace folder, timers, events
- `src/core/`: the quiz logic (`quiz.ts` holds the state, prompts and generation)
- `src/host.ts`: the `Host` interface the core uses in place of the plugin's `$`. `src/node-host.ts` and `src/store.ts` are its VS Code versions
- `src/events.ts`: the bridge and transcript watchers
- `src/panel.ts` and `webview/`: the panel. The webview only draws snapshots and sends actions back
- `bridge/`: the Claude Code plugin that forwards events
- `test/`: `npm test` (vitest, plain Node, with a fake `Host`)
