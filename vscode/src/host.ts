// What the ported quiz logic needs from its surroundings: the part of the plugin's `$` it used.
// The VS Code implementation is in node-host.ts; tests use a fake

// JSON values by key. Every get reads fresh, since other windows write to the same files
export interface Store {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export type Entry = { name: string; kind: 'file' | 'directory' | 'other' }

export type RunResult = { exitCode: number; stdout: string; stderr: string }

export type FetchResult = { ok: boolean; status: number; text: string; headers: Record<string, string> }

export interface Host {
  // The workspace folder this quiz is about (the plugin's `$.session.root()`)
  root: string
  // Data about this project, in <root>/.brain-unrot/
  project: Store
  // General data, in ~/.brain-unrot/
  global: Store
  // ~/.brain-unrot itself: a neutral directory for background work that has no reason to read code
  globalDir: string
  fs: {
    exists(path: string): Promise<boolean>
    list(path: string): Promise<Entry[]>
    // The path with symlinks resolved
    realPath(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
  }
  // `argv[0]` of 'claude' runs the resolved claude CLI. The child gets no stdin
  run(argv: string[], options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<RunResult>
  now(): number
  fetch(url: string, init?: { headers?: Record<string, string> }): Promise<FetchResult>
  log(line: string): void
}
