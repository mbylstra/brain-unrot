import type { Question } from '../types'

// Shown while nothing has been generated yet, so the pane is never empty
export const SEEDS: Question[] = [
  {
    id: 'seed-git-status',
    prompt: 'Which git command shows files you have changed but not committed?',
    choices: ['git status', 'git log', 'git fetch', 'git init'],
    answer: 0,
    explanation: '`git status` lists staged, unstaged and untracked changes.',
  },
  {
    id: 'seed-http-404',
    prompt: 'What does an HTTP 404 response mean?',
    choices: ['Not found', 'Server error', 'Unauthorized', 'Success'],
    answer: 0,
    explanation: '404 means the server has nothing at that URL.',
  },
  {
    id: 'seed-json',
    prompt: 'Which of these is valid JSON?',
    choices: ['{"a": 1}', "{'a': 1}", '{a: 1}', '{"a": 1,}'],
    answer: 0,
    explanation: 'JSON keys need double quotes, and trailing commas are not allowed.',
  },
  {
    id: 'seed-array-index',
    prompt: 'In most languages, what is the index of the first element of an array?',
    choices: ['0', '1', '-1', 'It depends on the array length'],
    answer: 0,
    explanation: 'Arrays in C, JS, Python, Java and most others are zero-indexed.',
  },
  {
    id: 'seed-ls',
    prompt: 'Which shell command lists the files in the current directory?',
    choices: ['ls', 'cd', 'pwd', 'cat'],
    answer: 0,
    explanation: '`ls` lists files; `pwd` prints the directory you are in.',
  },
  {
    id: 'seed-const',
    prompt: 'In JavaScript, what does `const` prevent?',
    choices: [
      'Reassigning the variable',
      'Changing the object it points to',
      'Reading the variable',
      'Using the variable in a function',
    ],
    answer: 0,
    explanation: '`const` stops reassignment; the object itself can still be mutated.',
  },
]
