# Quiz ideas

## Context

**Brain Unrot** gives you something useful to do while you wait for Claude
Code to finish a task: a quiz that helps you learn the codebase you're
working in. It opens by itself every time you submit a prompt, so you
never have to remember to start it.

How it works today:

- It's a Claude Code plugin in `plugin/`. It's installed per project from
  the local marketplace at the repo root
  (`claude plugin install brain-unrot@brain-unrot --scope local`), and
  `/reload-plugins` picks up edits.
- A `prompt.submit` hook starts a new round and opens a pane docked to the
  right of the chat (`hooks/register.tsx`).
- The pane never takes the keyboard. You click it (or press ctrl+x, then
  Tab) to answer, and Esc returns to the chat. A green or grey border shows
  whether it's focused.
- Right now the "quiz" is a placeholder: guess a number from 1 to 4.
- The plugin writes `plugin/.debug.log` (gitignored) so Claude can see what
  the pane did.

## Ideas

Ideas for what the pane asks while Claude works. Placeholders for now.

### Questions about the files Claude is touching

Watch `tool.call` events for files Claude reads or edits, and have a small
model (Haiku) write a multiple-choice question about one of them, e.g.
"What does `parseConfig` return when the file is missing?"

### Predict the change

After Claude edits a file, show the function name and ask what you think
changed and why, then reveal the diff.
