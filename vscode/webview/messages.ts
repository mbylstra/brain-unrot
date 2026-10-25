// The webview's only link to its host: actions go out, and `view` snapshots come in
import type { FromWebview, ToWebview, View } from '../src/panel'

declare function acquireVsCodeApi(): { postMessage(message: unknown): void }

const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: (m: unknown) => window.parent.postMessage(m, '*') }
export const send = (message: FromWebview) => vscode.postMessage(message)

// The latest snapshot, kept here so one that comes before React has drawn isn't lost
let latest: View | undefined
const listeners = new Set<() => void>()

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  if (e.data?.type !== 'view') return
  latest = e.data.view
  listeners.forEach(l => l())
})

export const views = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  latest: () => latest,
}
