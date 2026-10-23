import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'

import { CHAT_TICK_MS, Quiz, TICK_MS } from './core/quiz'
import { type ClaudeEvent, EventWatcher, isInside } from './events'
import { createHost, findClaude } from './node-host'
import { Panel } from './panel'
import { JsonStore } from './store'

const GLOBAL_DIR = join(homedir(), '.brain-unrot')
const EVENTS_PATH = join(GLOBAL_DIR, 'events.jsonl')
const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const LOG_LINES = 200

export async function activate(context: vscode.ExtensionContext) {
  // The output channel, and the last lines in a file Claude can read (it can't see the panel)
  const output = vscode.window.createOutputChannel('Brain Unrot')
  const trail: string[] = []
  const logPath = join(context.logUri.fsPath, 'debug.log')
  void mkdir(context.logUri.fsPath, { recursive: true })
  const log = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`
    output.appendLine(stamped)
    trail.push(stamped)
    if (trail.length > LOG_LINES) trail.splice(0, trail.length - LOG_LINES)
    void writeFile(logPath, trail.join('\n') + '\n').catch(() => undefined)
  }
  log(`activated; debug log at ${logPath}`)

  const config = () => vscode.workspace.getConfiguration('brainUnrot')
  const global = new JsonStore(GLOBAL_DIR)
  const claude = () => findClaude(config().get<string>('claudePath') ?? '', log)

  // One quiz per workspace folder. The panel shows the one Claude was last working in
  const quizzes = new Map<string, { quiz: Quiz; timers: NodeJS.Timeout[] }>()
  let activeRoot: string | undefined
  const active = () => (activeRoot ? quizzes.get(activeRoot)?.quiz : undefined) ?? quizzes.values().next().value?.quiz

  const panel = new Panel(vscode.Uri.joinPath(context.extensionUri, 'dist'), active, log)
  // Whether you closed the panel yourself; with `reopenOnPrompt` off, it then stays closed
  let isClosedByYou = false

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  status.command = 'brainUnrot.showQuiz'
  status.text = '$(mortar-board) Brain Unrot'
  status.show()

  // Several changes often land together: redraw once
  let isRedrawing = false
  const redraw = () => {
    if (isRedrawing) return
    isRedrawing = true
    queueMicrotask(() => {
      isRedrawing = false
      const quiz = active()
      if (quiz) status.tooltip = `Brain Unrot: ${quiz.state.ready} generated questions ready, ${quiz.state.tips} tidbits ready`
      void panel.refresh().catch(err => log(`refresh: ${String(err)}`))
    })
  }

  const addFolder = (root: string) => {
    if (quizzes.has(root)) return
    const host = createHost(root, { global, globalDir: GLOBAL_DIR, claude, log: line => log(`[${root.split('/').at(-1)}] ${line}`) })
    const quiz = new Quiz(host)
    quiz.onChange = () => {
      if (quiz === active()) redraw()
    }
    quizzes.set(root, { quiz, timers: [] })
    void quiz.start().catch(err => log(`start: ${String(err)}`))
    log(`watching ${root}`)
  }

  // Background work (which spends money on claude calls) only starts in a project once you've
  // used Claude or the quiz there, not in every folder that's open. It runs on timers, so it
  // outlives whatever queued it
  const wake = (root: string) => {
    const entry = quizzes.get(root)
    if (!entry || entry.timers.length > 0) return
    const { quiz } = entry
    entry.timers = [
      setInterval(() => void quiz.generate(), TICK_MS),
      setInterval(() => void quiz.discuss(), CHAT_TICK_MS),
      setInterval(() => void quiz.fileIssue(), CHAT_TICK_MS),
    ]
    log(`started background work for ${root}`)
  }

  const removeFolder = (root: string) => {
    quizzes.get(root)?.timers.forEach(clearInterval)
    quizzes.delete(root)
    if (activeRoot === root) activeRoot = undefined
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) addFolder(folder.uri.fsPath)

  // Tidbits are general, so one research timer is enough, whichever project it runs from. It waits
  // until some project here has been used
  const researchTimer = setInterval(() => {
    const quiz = active()
    if (quiz && quizzes.get(quiz.host.root)!.timers.length > 0) void quiz.research()
  }, TICK_MS)

  // The workspace folder an event happened in: the deepest one holding its cwd. Events from
  // other windows' folders are left to those windows
  const folderOf = (cwd: string) =>
    [...quizzes.keys()].filter(root => isInside(root, cwd)).sort((a, b) => b.length - a.length)[0]

  // Whether Claude has told us about a file read, through the bridge or a transcript. Until it
  // has, the files you save stand in for them
  let hasHeardReads = false

  const show = () => {
    isClosedByYou = false
    panel.show()
  }

  const onEvent = (e: ClaudeEvent) => {
    const root = folderOf(e.cwd)
    if (!root) return
    const quiz = quizzes.get(root)!.quiz
    wake(root)
    if (e.event === 'read') {
      hasHeardReads = true
      // Only files in the project: the background Claude can't read the rest
      if (e.file && isInside(root, e.file)) quiz.onRead(e.file)
      return
    }
    activeRoot = root
    if (e.event === 'stop') {
      log(`claude finished (${e.source})`)
      void quiz.onStop()
      return
    }
    log(`prompt submitted (${e.source})`)
    // Never hold up anything for the panel, and never take the focus
    void quiz.onPrompt().catch(err => log(`prompt: ${String(err)}`))
    if (!isClosedByYou || config().get<boolean>('reopenOnPrompt', true)) show()
    else redraw()
  }

  const watcher = new EventWatcher(EVENTS_PATH, PROJECTS_DIR, onEvent, log)
  await mkdir(GLOBAL_DIR, { recursive: true }).catch(() => undefined)
  await watcher.start()

  context.subscriptions.push(
    output,
    status,
    { dispose: () => watcher.stop() },
    { dispose: () => clearInterval(researchTimer) },
    { dispose: () => [...quizzes.keys()].forEach(removeFolder) },
    { dispose: () => panel.dispose() },
    panel.onDidClose(() => {
      isClosedByYou = true
    }),
    vscode.commands.registerCommand('brainUnrot.showQuiz', async () => {
      show()
      const quiz = active()
      if (quiz) wake(quiz.host.root)
      if (quiz && quiz.state.round === null) await quiz.newRound()
      redraw()
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(e => {
      e.added.forEach(f => addFolder(f.uri.fsPath))
      e.removed.forEach(f => removeFolder(f.uri.fsPath))
    }),
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (hasHeardReads || doc.uri.scheme !== 'file') return
      const root = folderOf(doc.uri.fsPath)
      if (root && !doc.uri.fsPath.includes('/.brain-unrot/')) quizzes.get(root)!.quiz.onRead(doc.uri.fsPath)
    }),
  )
}

export function deactivate() {}
