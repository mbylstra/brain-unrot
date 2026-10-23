import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Store } from './host'

// One JSON file per key, e.g. `quiz:prefs` in quiz-prefs.json, so the user (or Claude) can read,
// edit and delete them. Every get reads the file fresh, since other windows write here too.
// Writes go to a temp file that's then renamed, so a reader never sees half a file
export class JsonStore implements Store {
  constructor(
    readonly dir: string,
    // Written once, when the folder is first made (e.g. a .gitignore)
    private readonly seed: Record<string, string> = {},
  ) {}

  pathOf(key: string) {
    return join(this.dir, `${key.replace(/[^a-zA-Z0-9_-]+/g, '-')}.json`)
  }

  async get(key: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.pathOf(key), 'utf8'))
    } catch {
      return undefined
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.ensureDir()
    const path = this.pathOf(key)
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n')
    await rename(temp, path)
  }

  private isMade = false
  private async ensureDir() {
    if (this.isMade) return
    await mkdir(this.dir, { recursive: true })
    for (const [name, text] of Object.entries(this.seed)) {
      await writeFile(join(this.dir, name), text, { flag: 'wx' }).catch(() => undefined)
    }
    this.isMade = true
  }
}

// Project data stays out of git without touching the project's own .gitignore
export const projectStore = (root: string) => new JsonStore(join(root, '.brain-unrot'), { '.gitignore': '*\n' })
