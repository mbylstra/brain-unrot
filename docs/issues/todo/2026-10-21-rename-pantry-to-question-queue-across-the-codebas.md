# Rename "pantry" to "question queue" across the codebase

The "pantry" metaphor is not intuitive. Rename it to "question queue" everywhere it refers to the stored set of generated questions.

Where it appears:
- `plugin/hooks/register.tsx`: constants `PANTRY_MAX` and `PANTRY_LOW`; `pantryKey`, `loadPantry`, `savePantry`, and `withPantry`; the comments describing the pantry; and the `pantry` parameters and variables in `avoiding`, `FILE_PROMPT`, `REPO_PROMPT`, and the tick handler.
- `plugin/tests/quiz.test.tsx`: test titles and comments that mention the pantry, and the `pantry` variables.
- `plans/quiz-ideas.md`: the design notes that describe the pantry.

Note that the storage key `pantry:<root>` is persisted in `$.store`. Renaming it (for example to `queue:<root>`) will orphan questions already stored for existing repos unless we migrate or accept losing them. Decide that as part of this change.

## Context

Raised while answering a Brain Unrot quiz question about `plugin/tests/quiz.test.tsx`:

> What does the mocked `process.run` return as stdout for a prompt containing 'clarifying question'?

Original note:

> Rename "pantry" to "question queue" across the codebase. The pantry metaphor is not inuitive.
