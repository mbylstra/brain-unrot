# Quiz repeats the same question instead of moving on

The quiz keeps asking the same question again. A question should only come back if the developer answered it wrong the first time.

Example: the question "Which folder do filed issues get written to?" (answer: `docs/issues/todo`, set by `ISSUES_DIR` in `plugin/hooks/register.tsx`) was asked again after it had already been answered correctly.

The question selection happens in `nextQuestion` in `plugin/hooks/register.tsx`. It takes a question from the queue or falls back to `SEEDS`, and it doesn't check whether the developer has already answered that question correctly.

Expected: a question answered correctly is not asked again. A question answered incorrectly may be asked again.

## Context

Raised while answering a Brain Unrot quiz question about `plugin/hooks/register.tsx`:

> Which folder do filed issues get written to?

Original note:

> The system seems to ask the same question repeatedly. It should not ask the same question again, unless it was wrong answer the first time.
