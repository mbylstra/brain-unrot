// The quiz UI. It talks to its host only through messages (a `view` snapshot in, actions out),
// so the same bundle could later be served elsewhere, e.g. as an MCP App
import { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app'
import { send, views } from './messages'
import css from './style.css?inline'

// --- Keys ---

// A button with a `data-hotkey` is pressed by its key (outside a text box), and Enter presses the primary one
document.addEventListener('keydown', e => {
  if (e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return
  const key = e.key.toLowerCase()
  const pressed =
    document.querySelector<HTMLButtonElement>(`button[data-hotkey="${CSS.escape(key)}"]`) ??
    (key === 'enter' && !(e.target instanceof HTMLButtonElement) ? document.querySelector<HTMLButtonElement>('button[data-primary]') : null)
  if (!pressed) return
  e.preventDefault()
  pressed.click()
})

// --- Start ---

// VS Code gives every webview default styles for `code`, `kbd`, links and the body's padding, in its
// own colours. Drop them, so only shadcn's styles apply
document.getElementById('_defaultStyles')?.remove()
const style = document.createElement('style')
style.textContent = css
document.head.append(style)

// shadcn's dark theme, when VS Code's is dark. VS Code changes the body's class when you switch themes
const isDark = () => {
  const classes = document.body.classList
  return classes.contains('vscode-dark') || (classes.contains('vscode-high-contrast') && !classes.contains('vscode-high-contrast-light'))
}
const followTheme = () => document.documentElement.classList.toggle('dark', isDark())
followTheme()
new MutationObserver(followTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] })

function Root() {
  const view = useSyncExternalStore(views.subscribe, views.latest)
  return view ? <App view={view} /> : null
}

createRoot(document.getElementById('app')!).render(<Root />)
send({ type: 'ready' })
