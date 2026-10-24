# Stop repeating questions and tidbits

Status: done on 2026-10-24. All five steps are built as planned. The tidbit research test is in `vscode/test/tidbits.test.ts`, and skipped questions are still remembered (see the open question below). Not yet tried in the packaged extension.

## Context

The quiz keeps asking questions, and showing tidbits, that are the same as
or very close to ones already seen. Three ideas were suggested to fix it:

1. Keep the history of general (concept) questions in one place on the
   machine, not in each project, because projects change often.
2. Keep the history of repo-specific questions in the repo.
3. Stop the model from writing the same or similar questions by giving it
   the **whole** list of questions already answered.

Only questions answered **right** need to be avoided. A question answered
wrong may come back.

## What's already in place

Ideas 1 and 2 already work this way. The repeats come from elsewhere.

- Concept questions and their answered list are global, in
  `~/.brain-unrot/concepts` and `~/.brain-unrot/answered`. Seed questions
  answered there go to the global list too (`remember`, `quiz.ts:557`).
- Codebase and instruction questions and their answered list are kept per
  project, in `<project>/.brain-unrot/queue` and `answered`.
- A wrong answer is never remembered. The question goes to the back of its
  queue (`requeue`, `quiz.ts:565`).
- Generation already sends an avoid list to the model (`avoiding`,
  `quiz.ts:198`), and afterwards drops any question whose text exactly
  matches one answered right (`quiz.ts:1050`).

The machine-wide `answered` list has 109 prompts today. It includes
near-duplicates like "What is the main benefit of TypeScript's static types
over plain JavaScript?" and "What is a key benefit of a statically typed
language such as Rust or Dart compared to a dynamically typed one?".

## Why repeats get through

1. **The avoid list is cut short.** `AVOID_MAX = 50` (`quiz.ts:18`) means
   only the last 50 prompts answered right reach the model. With 109
   stored, 59 are invisible to concept generation right now.
2. **Memory is cut short.** `ANSWERED_MAX = 200` (`quiz.ts:17`) drops the
   oldest prompts altogether. Once a prompt is dropped, even the
   exact-match filter forgets it.
3. **The prompt only asks for no exact repeats.** It says "Don't repeat
   these questions", so a reworded question testing the same idea counts as
   new. The `said()` filter after generation only compares normalised text,
   so the prompt wording is the only defence against near-duplicates.
4. **Tidbit research sees only the tidbits in the queue.** `research`
   (`tidbits.ts:463`) passes the headlines in `tidbits`, at most 40. It
   doesn't pass those already shown (`tidbits:history`, up to 500). Those
   leave the queue when shown, so the model doesn't know about them. The
   hash check in `addTidbits` matches only an exact headline or the same
   URL, so the same tip from another page, worded differently, gets
   through.
5. **Two windows can generate at once.** `lock` only covers one window, so
   two windows writing concept questions can both work from the same avoid
   list. This is minor, and not fixed here.

## Plan

### 1. Send the whole answered list

- Remove `AVOID_MAX`. `avoiding` sends every prompt answered right in the
  scope (global for concept questions, the project's own for codebase and
  instruction questions), plus the questions already waiting in that queue.
- Raise `ANSWERED_MAX` to 2000. At about 100 characters a prompt, 1000
  prompts come to roughly 25k tokens, which Haiku and Sonnet handle well.
  The cap is only there to stop the list growing forever. At one answer a
  minute it takes months of use to reach it.
- For concept questions, list the prompts on the topic being written about
  first, under their own heading, then the rest. Once a list runs to
  hundreds of prompts, this keeps the closest ones where the model attends
  to them. To do this, the answered entries need a topic (see step 3).

### 2. Ask for no similar questions, not just no exact repeats

Reword the avoid section for every question prompt along these lines:

> The developer has already answered these questions correctly. Don't write
> a question that tests the same idea as any of them, even in other words or
> with a different example. Pick ideas they haven't been asked about.

Say separately that the questions waiting in the queue are ones they will
be asked soon, so they shouldn't be repeated either.

### 3. Store answered entries as records

`answered` is a list of strings today. Change each entry to
`{ prompt, topic?, at }`, where `topic` is the concept topic and `at` is
when it was answered.

- Keep reading the old format, as CLAUDE.md requires. A plain string is
  read as `{ prompt }`.
- Write the new format from then on. Every reader goes through
  `loadAnsweredIn`, so only that function and `remember` change.

### 4. Tidbits: anything shown counts as known

Tidbits aren't answered, so for them, shown means known.

- Pass `RESEARCH_PROMPT` the headlines of everything in `tidbits:history`
  and the queue, plus the seed tidbits' headlines (seeds are recorded only
  by id in `known`).
- Reword the avoid section to match step 2: "The developer already knows
  these tips. Don't return one that makes the same point, even from another
  source."
- History is capped at 500 (`HISTORY_MAX`), roughly 10k tokens of
  headlines. That's fine for Sonnet, so keep the cap.

### 5. Tests

- Update the existing answered-list tests (`test/quiz.test.ts:75`, `:93`,
  `:115`) for the record format.
- Add one that stores old-format strings and checks they're still treated
  as answered.
- Add one that stores more than 50 prompts answered right and checks they
  all reach the generation prompt (the fake host records what was sent to
  `claude`).
- Add one that checks a concept prompt lists its own topic's prompts
  first.
- Add one in the tidbits tests that checks shown tidbits' headlines reach
  the research prompt.

## Open question: skipped questions

Decided: kept as it is. A skipped question is remembered and stays in the avoid list.

A skipped question is remembered as well (`quiz.ts:846`), so it's never
asked again and goes into the avoid list. The request was to avoid only
questions answered right. The options are:

- **Keep it as it is (recommended).** Skip already means "don't ask me
  this", which is why it was added
  (`docs/issues/done/2026-10-21-let-users-skip-a-multiple-choice-question-and-stop.md`),
  and a reworded copy of a skipped question is just as unwanted.
- **Let skipped questions come back.** Treat a skip like a wrong answer:
  requeue it and leave it out of the avoid list.

## Not in this plan

- Deduplicating by meaning in code (embeddings or a second model call to
  compare). Try the full list and the better wording first, and only add
  this if repeats still get through.
- A lock across windows for concept generation (point 5 above).
