# Let the question-generating Claude use git to read history

The brainrot LLM can't read git history. `askClaude` in `plugin/hooks/register.tsx` runs the `claude` CLI with `--tools Read,Grep,Glob`, so it has no way to run `git log` or similar. Allowing git read commands (for example, `Bash(git log:*)` and `Bash(git show:*)`) would let it use commit history when writing questions.

## Context

Raised while answering a Brain Unrot quiz question about `plugin/hooks/seeds.ts`:

> What do the `SEEDS` in `seeds.ts` hold?

Original note:

> allow the brainrot LLM to use git to read git history
