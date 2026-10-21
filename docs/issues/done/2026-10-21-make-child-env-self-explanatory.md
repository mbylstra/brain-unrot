# Make CHILD_ENV self-explanatory

`CHILD_ENV` in `plugin/hooks/claude.ts` (line 3, `export const CHILD_ENV = 'BRAIN_UNROT_CHILD'`) doesn't say what it does. Its purpose is to switch the plugin off in the child `claude` process, but the name alone doesn't convey that. A reader has to go to `askClaude` (line 59, which sets `{ [CHILD_ENV]: '1' }`) and then to the check in `plugin/hooks/register.tsx` to work it out.

Suggested change: give the constant a name that states its purpose, for example `DISABLE_PLUGIN_ENV` or `IS_CHILD_CLAUDE_ENV`, and/or add a short comment at the declaration saying that the plugin checks this variable and turns itself off when it is set. Either would make it clear without reading the call site.

## Context

Raised while answering a Brain Unrot quiz question about `plugin/hooks/claude.ts`:

> What is `CHILD_ENV` for?

Original note:

> It is completely unclear to me what CHILD_ENV is for. It shoud be more self explanatory.
