import type { FetchResult, Host, RunResult, Store } from '../src/host'

export class MemoryStore implements Store {
  readonly data = new Map<string, unknown>()
  async get(key: string) {
    // A copy, as a JSON file would give
    const value = this.data.get(key)
    return value === undefined ? undefined : structuredClone(value)
  }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value))
  }
}

// A Host with in-memory stores and files. `claude` answers each `claude -p` call with the
// prompt it was given; calls are recorded in `runs`
export function fakeHost(options: { root?: string; global?: MemoryStore; files?: Record<string, string>; claude?: (prompt: string, argv: string[]) => string } = {}) {
  const files = new Map(Object.entries(options.files ?? {}))
  const runs: { argv: string[]; cwd?: string; env?: Record<string, string> }[] = []
  const log: string[] = []
  let now = Date.parse('2026-10-23T00:00:00Z')
  const host: Host = {
    root: options.root ?? '/repo',
    project: new MemoryStore(),
    global: options.global ?? new MemoryStore(),
    globalDir: '/home/.brain-unrot',
    fs: {
      exists: async path => files.has(path) || [...files.keys()].some(f => f.startsWith(path + '/')),
      list: async path => {
        const names = new Map<string, 'file' | 'directory'>()
        for (const f of files.keys()) {
          if (!f.startsWith(path + '/')) continue
          const [name, ...rest] = f.slice(path.length + 1).split('/')
          names.set(name!, rest.length > 0 ? 'directory' : 'file')
        }
        return [...names].map(([name, kind]) => ({ name, kind }))
      },
      realPath: async path => path,
      write: async (path, text) => {
        files.set(path, text)
      },
    },
    run: async (argv, opts): Promise<RunResult> => {
      runs.push({ argv, cwd: opts?.cwd, env: opts?.env })
      if (argv[1] !== '-p') return { exitCode: 0, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: options.claude?.(argv[2]!, argv) ?? '', stderr: '' }
    },
    now: () => now,
    fetch: async (): Promise<FetchResult> => ({ ok: false, status: 500, text: '', headers: {} }),
    log: line => log.push(line),
  }
  return { host, files, runs, log, advance: (ms: number) => (now += ms) }
}

export const questionsJson = (prompts: string[], sourceFile?: string) =>
  JSON.stringify(prompts.map(prompt => ({ prompt, choices: ['a', 'b', 'c', 'd'], answer: 0, explanation: 'because', sourceFile })))
