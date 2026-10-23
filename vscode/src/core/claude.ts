// Ported from plugin/hooks/claude.ts in the CLI plugin (the `cli-plugin` tag)
import type { Host } from '../host'

// Name of the environment variable set on the claude process we spawn; when present, the bridge plugin switches itself off there
export const DISABLE_PLUGIN_ENV_VAR = 'BRAIN_UNROT_CHILD'
const CLI_TIMEOUT_MS = 5 * 60_000

export const random = (n: number) => {
  const [r = 0] = crypto.getRandomValues(new Uint32Array(1))
  return r % n
}

// `tools` are the tools the child has; `allowed` are permission rules for the ones that
// need asking (Bash, WebSearch, WebFetch): dontAsk refuses anything not allowed,
// whatever permission mode the user's settings default to.
// `schema` asks for JSON output that matches it, and `budget` caps the call in USD
export type Ask = {
  model: string
  tools: string[]
  allowed?: string[]
  cwd: string
  schema?: object
  budget?: number
}

export type Answer = { text: string; data?: unknown; cost?: number }

// Hardcoded to the claude CLI for now; other backends can come later
export async function askClaude(host: Host, prompt: string, ask: Ask): Promise<Answer> {
  const { exitCode, stdout, stderr } = await host.run(
    [
      'claude',
      '-p',
      prompt,
      '--model',
      ask.model,
      '--tools',
      ask.tools.join(','),
      ...(ask.allowed?.length ? ['--allowedTools', ...ask.allowed] : []),
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      'user',
      // The user's own hooks (e.g. a Stop notification) are meant for their session, not this one
      '--settings',
      JSON.stringify({ disableAllHooks: true }),
      '--strict-mcp-config',
      '--no-session-persistence',
      ...(ask.schema ? ['--output-format', 'json', '--json-schema', JSON.stringify(ask.schema)] : []),
      ...(ask.budget ? ['--max-budget-usd', String(ask.budget)] : []),
    ],
    // The child would load the bridge plugin too; DISABLE_PLUGIN_ENV_VAR switches it off there
    { cwd: ask.cwd, env: { [DISABLE_PLUGIN_ENV_VAR]: '1' }, timeoutMs: CLI_TIMEOUT_MS },
  )
  if (exitCode !== 0) throw new Error(`claude exited ${exitCode}: ${stderr.slice(0, 200)}`)
  if (!ask.schema) return { text: stdout }
  // --output-format json: one object with the reply, the structured output and the cost
  const reply = JSON.parse(stdout) as { result?: string; structured_output?: unknown; total_cost_usd?: number; is_error?: boolean; subtype?: string }
  if (reply.is_error) throw new Error(`claude failed: ${reply.subtype ?? 'error'}`)
  return { text: reply.result ?? '', data: reply.structured_output, cost: reply.total_cost_usd }
}
