import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'

import type { Action, Quiz } from './core/quiz'

export type View = Awaited<ReturnType<Quiz['view']>>

// Extension → webview: a full snapshot of what to show. Webview → extension: an action, or
// `ready` once its script has loaded (messages posted before then are dropped)
export type ToWebview = { type: 'view'; view: View }
export type FromWebview = { type: 'ready' } | Action

// The webview is only a view: the extension holds the state and posts a snapshot on every change
export class Panel {
  private panel: vscode.WebviewPanel | undefined
  private isReady = false
  private readonly closed = new vscode.EventEmitter<void>()
  // Fires when the panel is closed (by you, or when the window closes)
  readonly onDidClose = this.closed.event

  constructor(
    private readonly distUri: vscode.Uri,
    private readonly quiz: () => Quiz | undefined,
    private readonly log: (line: string) => void,
  ) {}

  get isOpen() {
    return this.panel !== undefined
  }

  // Never takes the keyboard focus: you click the panel to answer
  show() {
    if (this.panel) {
      // Where it already is: `Beside` would move it on every prompt
      this.panel.reveal(undefined, true)
      return
    }
    this.panel = vscode.window.createWebviewPanel(
      'brainUnrot',
      'Brain Unrot',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.distUri] },
    )
    this.isReady = false
    this.panel.webview.html = this.html(this.panel.webview)
    this.panel.webview.onDidReceiveMessage((message: FromWebview) => void this.receive(message))
    this.panel.onDidDispose(() => {
      this.panel = undefined
      this.closed.fire()
    })
  }

  dispose() {
    this.panel?.dispose()
    this.closed.dispose()
  }

  async refresh() {
    const quiz = this.quiz()
    if (!this.panel || !this.isReady || !quiz) return
    const message: ToWebview = { type: 'view', view: await quiz.view() }
    await this.panel.webview.postMessage(message)
  }

  private async receive(message: FromWebview) {
    if (message.type === 'ready') {
      this.isReady = true
      return this.refresh()
    }
    try {
      await this.quiz()?.act(message)
    } catch (err) {
      this.log(`action ${message.type}: ${String(err)}`)
    }
  }

  private html(webview: vscode.Webview) {
    const nonce = randomBytes(16).toString('base64')
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.distUri, 'webview.js'))
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brain Unrot</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
  }
}
