import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Round } from '../types'

const PANE = 'brain-unrot'
const CHOICES = [1, 2, 3, 4]
const round = atom({ plugin: 'brain-unrot', key: 'round' } as const, null as Round | null)

const newRound = (): Round => {
  const [n = 0] = crypto.getRandomValues(new Uint32Array(1))
  return { answer: (n % CHOICES.length) + 1, guess: null }
}

// Debug trail Claude can read back (the transcript isn't visible to it)
const trail: string[] = []

function debug($: EngineInterface, line: string) {
  trail.push(`${new Date().toISOString()} ${line}`)
  void $.fs.write(`${$.plugin.root}/.debug.log`, trail.slice(-200).join('\n') + '\n').catch(() => undefined)
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)

    // Never take the keyboard: the person clicks the pane to answer.
    // Never hold up the prompt for the pane.
    if (!e.command) {
      debug($, `prompt accepted: ${JSON.stringify(e.text.slice(0, 60))}`)
      void update($, round, newRound)
        .then(() => $.ui.open({ id: PANE, title: 'Brain Unrot' }))
        .then(opened => debug($, `open: ${JSON.stringify(opened)}`))
        .catch(() => undefined)
    }

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, round)
    debug($, `render: focused=${e.props.isFocused} placement=${e.props.placement} round=${JSON.stringify(current)}`)

    const isFocused = e.props.isFocused
    const frame = (body: JSX.Element) => (
      <Box flexDirection="column" gap={1} borderStyle="round" borderColor={isFocused ? 'green' : 'gray'} paddingX={1}>
        {isFocused ? (
          <Text color="green" bold>● Answering — Esc returns to chat</Text>
        ) : (
          <Text color="yellow">○ Click here to answer (or press ctrl+x, then Tab)</Text>
        )}
        {body}
      </Box>
    )

    if (current === null) {
      return frame(<Text dimColor>No round yet.</Text>)
    }

    const guess = (n: number) => () => {
      debug($, `guess: ${n}`)
      return update($, round, r => (r ? { ...r, guess: n } : r))
    }

    if (current.guess === null) {
      return frame(
        <Box flexDirection="column" gap={1}>
          <Text bold>I'm thinking of a number. Which one?</Text>
          <Box flexDirection="column">
            {CHOICES.map(n => (
              <Button key={`guess-${n}`} plain hotkey={String(n)} label={String(n)} onPress={guess(n)} />
            ))}
          </Box>
        </Box>
      )
    }

    const isRight = current.guess === current.answer

    return frame(
      <Box flexDirection="column" gap={1}>
        <Text bold color={isRight ? 'green' : 'red'}>
          {isRight ? 'Correct!' : `Wrong — it was ${current.answer}.`}
        </Text>
        <Text dimColor>You guessed {current.guess}.</Text>
        <Button key="again" hotkey="a" label="Play again" onPress={() => update($, round, newRound)} />
      </Box>
    )
  })
}
