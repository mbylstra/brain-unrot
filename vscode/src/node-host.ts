import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readdir, realpath, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Entry, Host, RunResult, Store } from './host'
import { projectStore } from './store'

// Where claude is, and the PATH to run it with. VS Code started from the macOS Dock often lacks
// the user's shell PATH, so unless `brainUnrot.claudePath` is set, both come from a login shell, once
export type Claude = { path: string; env: Record<string, string> }

let found: Promise<Claude> | undefined

// Where the installers put it, for when the login shell doesn't say (zsh -l skips .zshrc)
const INSTALL_PATHS = ['.local/bin/claude', '.claude/local/claude'].map(p => join(homedir(), p)).concat(['/opt/homebrew/bin/claude', '/usr/local/bin/claude'])
// Printed before the answer, so whatever the profile scripts print doesn't get mistaken for it
const MARKER = '__BRAIN_UNROT__'

export function findClaude(configured: string, log: (line: string) => void): Promise<Claude> {
  if (configured) return Promise.resolve({ path: configured, env: {} })
  found ??= new Promise(resolve => {
    const shell = process.env.SHELL || '/bin/sh'
    execFile(shell, ['-lc', `printf '%s\\n' ${MARKER}; command -v claude; printf '%s\\n' "$PATH"`], { timeout: 10_000 }, async (err, stdout) => {
      const [path = '', shellPath = ''] = stdout.slice(stdout.lastIndexOf(MARKER) + MARKER.length).trim().split('\n')
      const env: Record<string, string> = shellPath.includes('/') ? { PATH: shellPath } : {}
      if (path.startsWith('/')) {
        log(`claude: ${path}`)
        return resolve({ path, env })
      }
      for (const candidate of INSTALL_PATHS) {
        if (await access(candidate, constants.X_OK).then(() => true, () => false)) {
          log(`claude: ${candidate} (not on ${shell}'s PATH)`)
          return resolve({ path: candidate, env })
        }
      }
      log(`claude not found through ${shell} (${String(err ?? 'not on its PATH')}); trying plain "claude". Set brainUnrot.claudePath`)
      resolve({ path: 'claude', env })
    })
  })
  return found
}

export function run(argv: string[], options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv
    // No stdin: `claude -p` can wait on an open pipe
    const child = spawn(command!, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM')
          reject(new Error(`${command} timed out after ${options.timeoutMs} ms`))
        }, options.timeoutMs)
      : undefined
    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, stdout, stderr })
    })
  })
}

export function createHost(root: string, deps: { global: Store; globalDir: string; claude: () => Promise<Claude>; log: (line: string) => void }): Host {
  return {
    root,
    project: projectStore(root),
    global: deps.global,
    globalDir: deps.globalDir,
    fs: {
      exists: path =>
        access(path).then(
          () => true,
          () => false,
        ),
      list: async path =>
        (await readdir(path, { withFileTypes: true })).map(
          (d): Entry => ({ name: d.name, kind: d.isFile() ? 'file' : d.isDirectory() || d.isSymbolicLink() ? 'directory' : 'other' }),
        ),
      realPath: path => realpath(path),
      write: async (path, text) => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, text)
      },
    },
    run: async (argv, options = {}) => {
      if (argv[0] !== 'claude') return run(argv, options)
      const claude = await deps.claude()
      // The background work runs from ~/.brain-unrot unless it's about the project
      await mkdir(deps.globalDir, { recursive: true })
      return run([claude.path, ...argv.slice(1)], { cwd: deps.globalDir, ...options, env: { ...claude.env, ...options.env } })
    },
    now: () => Date.now(),
    fetch: async (url, init) => {
      const res = await fetch(url, { headers: init?.headers })
      return { ok: res.ok, status: res.status, text: res.status === 304 ? '' : await res.text(), headers: Object.fromEntries(res.headers.entries()) }
    },
    log: deps.log,
  }
}
