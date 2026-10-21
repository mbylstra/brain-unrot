# Quiz wording: "seed questions" is too vague

The quiz question asks "Which file holds the seed questions shown before anything is generated?" The word "seed" is internal jargon. It is only explained by a comment in `plugin/hooks/seeds.ts` (`// Shown while nothing has been generated yet`), so a reader of the quiz cannot tell what it means.

**Where:** the prompt text of this quiz question. The answer is correct: `SEEDS` in `plugin/hooks/seeds.ts` is the fallback list shown while the queue is empty.

**Suggested change:** reword the prompt to say "see questions" in place of "seed questions", so it no longer depends on the term "seed".

## Context

Raised while answering a Brain Unrot quiz question about `plugin/hooks/seeds.ts`:

> Which file holds the seed questions shown before anything is generated?

Original note:

> "seeds" is too vague. should be "see questions"
