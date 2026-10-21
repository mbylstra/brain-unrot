# Let the clarifying-question chat edit files in docs/issues/todo

The clarifying-question chat runs a Claude subprocess with `CODE` (`plugin/hooks/register.tsx:23`), which gives it `Read`, `Grep`, `Glob` and `Bash` (git history only). It can't edit files, so it can't write to the issues folder.

The suggested change is to let the subprocess edit anything in `docs/issues/todo`, the folder `ISSUES_DIR` points to (`plugin/hooks/register.tsx:20`). The chat call is at `plugin/hooks/register.tsx:317`, and `CHAT_PROMPT` is at line 259.

## Context

Raised while answering a Brain Unrot quiz question about `plugin/hooks/hooks.json`:

> Which module does `hooks.json` list as the plugin's entry point?

Original note:

> In the "ask a clarifying question prompt", the claude subprocess should be allowed to edit anything in docs/todos.
