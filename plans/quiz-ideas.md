# Quiz ideas

Ideas for what the pane asks while Claude works. Placeholders for now.

## Questions about the files Claude is touching

Watch `tool.call` events for files Claude reads or edits, and have a small
model (Haiku) write a multiple-choice question about one of them, e.g.
"What does `parseConfig` return when the file is missing?"

## Predict the change

After Claude edits a file, show the function name and ask what you think
changed and why, then reveal the diff.
