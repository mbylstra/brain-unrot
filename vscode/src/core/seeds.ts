import type { Question, Tidbit } from './types'

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

// Evergreen tidbits, shown while research hasn't found anything yet
const seed = (id: string, topic: Tidbit['topic'], headline: string, body: string, url: string, tryIt?: string): Tidbit => ({
  id: `seed-${id}`,
  headline,
  body,
  tryIt,
  url,
  quote: '',
  topic,
  lane: 'seed',
  isVerified: false,
})

export const SEED_TIDBITS: Tidbit[] = [
  seed(
    'clear-compact',
    'context management',
    '`/clear` and `/compact` both free up context, in different ways.',
    '`/clear` starts the conversation over; `/compact` replaces it with a summary and carries on. Clear between unrelated tasks, compact when you are mid-task and the context is filling up.',
    'https://code.claude.com/docs/en/slash-commands',
    '/compact keep the failing test names and the plan',
  ),
  seed(
    'claude-md',
    'context management',
    'A `CLAUDE.md` file at the repo root is read at the start of every session.',
    'Put the commands to build and test, the conventions Claude keeps getting wrong, and where things live. Keep it short: every line costs context in every session.',
    'https://code.claude.com/docs/en/memory',
    '/init',
  ),
  seed(
    'plan-mode',
    'prompting',
    'Plan mode has Claude read and propose before it changes anything.',
    'For a change that touches several files, agreeing on the plan first is cheaper than undoing a wrong approach. Press Shift+Tab to cycle into it.',
    'https://code.claude.com/docs/en/common-workflows',
  ),
  seed(
    'tests-first',
    'testing and verification',
    'Asking for failing tests first gives Claude a target it can check itself against.',
    'Have it write the tests, confirm they fail, then write the code until they pass. A check it can run beats a description it has to interpret.',
    'https://www.anthropic.com/engineering/claude-code-best-practices',
  ),
  seed(
    'subagents',
    'agents and subagents',
    'Subagents work in their own context window and hand back only a summary.',
    'A broad search or a long investigation in a subagent keeps the main conversation small. Define your own in `.claude/agents/`.',
    'https://code.claude.com/docs/en/sub-agents',
    '/agents',
  ),
  seed(
    'worktrees',
    'IDE and CLI workflow',
    'Git worktrees let several Claude sessions work on one repo without stepping on each other.',
    'Each worktree is its own checkout on its own branch, so parallel tasks keep their changes apart.',
    'https://code.claude.com/docs/en/common-workflows',
    'git worktree add ../my-feature -b my-feature',
  ),
  seed(
    'hooks',
    'testing and verification',
    'Hooks run your own commands at fixed points, such as after every file edit.',
    'A `PostToolUse` hook that runs the formatter or type checker catches mistakes every time, rather than when Claude remembers to check.',
    'https://code.claude.com/docs/en/hooks',
    '/hooks',
  ),
  seed(
    'permissions',
    'security',
    'Permission rules can allow the commands you trust and deny the ones you never want run.',
    'Rules like `Bash(npm test:*)` in your settings stop the prompts for safe commands, and deny rules hold even in looser permission modes.',
    'https://code.claude.com/docs/en/settings',
    '/permissions',
  ),
  seed(
    'model-choice',
    'cost and model choice',
    'You can switch models mid-session to match the task.',
    'A bigger model pays off for planning and tricky debugging; a smaller one is cheaper and faster for routine edits.',
    'https://code.claude.com/docs/en/costs',
    '/model',
  ),
  seed(
    'headless',
    'IDE and CLI workflow',
    '`claude -p` runs one prompt without the interactive UI, for scripts and CI.',
    'Pipe input in and get the answer on stdout; `--output-format json` adds the cost and session id.',
    'https://code.claude.com/docs/en/headless',
    'git diff | claude -p "review this diff for bugs"',
  ),
]
