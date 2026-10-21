# Rename "level" to "difficulty" across the codebase and UI

The quiz uses "level" for the difficulty of a question and of the user's current position on the staircase. It should say "difficulty" throughout, in code and in the UI.

Where it appears:
- `plugin/types/index.d.ts`: the `level` field on `Question` (line 10) and on `Skill` (line 32).
- `plugin/hooks/register.tsx`: the `skill` atom default and `readSkill`/`stepSkill` logic (`s.level`, `stored?.level`), `levelOf`, `fits`, `parseQuestions`, the generation prompts, and the footer text `Level {Math.floor(level)} of {LEVEL_MAX}`.
- `plugin/tests/quiz.test.tsx`: fixtures and the `Level N of 5` assertions.
- Comments and debug strings in the same files.

Note that `register.tsx` already has a `const difficulty = (level: number) => ...` helper that builds the prompt text. Rename that helper, or fold it into the new name, so the two don't clash.

Suggested change: rename the `level` identifiers and the UI copy to `difficulty`, and update the tests to match.

## Context

Raised while answering a Brain Unrot quiz question about `plugin/hooks/register.tsx`:

> What does `random(n)` return?

Original note:

> rename "level" to "difficulty" across the codebase and UI
