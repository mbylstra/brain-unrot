# Let users skip a multiple-choice question and stop it coming back

Multiple-choice questions in the quiz pane should have a "skip question" option, and a skipped question should not be asked again.

A "Skip this question" button already exists in `plugin/hooks/register.tsx` (the `skip` handler, around line 749, which only logs and calls `newRound`). It records nothing, so the skipped question can come back in a later round. Skipping should mark the question so it is not asked again, the same way answering it correctly does via `remember`.

## Context

Raised while answering a Brain Unrot quiz question about `plugin/hooks/tidbits.ts`:

> What does `ago` return for a date exactly one day before now?

Original note:

> add a "skip question" option to the multi choice questions (and don't ask it again)
