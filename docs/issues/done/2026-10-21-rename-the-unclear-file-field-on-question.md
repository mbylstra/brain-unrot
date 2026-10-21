# Rename the unclear `file` field on `Question`

It is not obvious what the `file` field on the `Question` type does, so it should have a clearer name.

**Where:** `plugin/types/index.d.ts`, the `file?: string` field on `Question`. It is read in `plugin/hooks/register.tsx`, e.g. in `parseQuestions` and in the question-display and debug code.

The field holds the path of the file a question was generated from, and it is absent on seed questions. A name that says so would make that clear at a glance.

## Context

Raised while answering a Brain Unrot quiz question about `plugin/types/index.d.ts`:

> What does the `file` field on a `Question` hold?

Original note:

> It is not obvious what this field does, so it should have a better name.
