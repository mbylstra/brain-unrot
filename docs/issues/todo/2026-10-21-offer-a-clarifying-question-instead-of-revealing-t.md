# Offer a clarifying question instead of revealing the answer on "Absolutely no idea"

Choosing "5. Absolutely no idea" immediately reveals the correct answer ("No worries — it was …"). The quiz should not stop there. It should also offer "6. Ask a clarifying question" so the developer can ask about the question before the answer is shown.

**Where:** `plugin/hooks/register.tsx`. The "no idea" button is wired to `choose(NO_IDEA)` (around line 550). The clarifying-question button is only rendered in the `guess === null` branch (around line 609), so once `guess` is set to `NO_IDEA` it disappears. The verdict is then rendered in the `guess === NO_IDEA` branch (around line 618).

## Context

Raised while answering a Brain Unrot quiz question about `plugin/hooks/register.tsx`:

> What does `parseQuestions` return when the reply has no valid JSON array?

Original note:

> When choosing "Absolutely no idea", the program says what the answer is. There should be an optoin to ask a clarifying quesitno
