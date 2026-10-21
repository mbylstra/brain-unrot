import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { LastPrompt } from '../types'

const PANE = 'brain-unrot'
const lastPrompt = atom({ plugin: 'brain-unrot', key: 'lastPrompt' } as const, null as LastPrompt)

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (!e.command) {
      // Never hold up the prompt for the pane
      void update($, lastPrompt, () => e.text)
        .then(() => $.ui.open({ id: PANE, title: 'Brain Unrot' }))
        .catch(() => undefined)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const text = await read($, lastPrompt)

    return (
      <Box flexDirection="column">
        <Text bold>You asked:</Text>
        <Text>{text ?? 'No prompt yet.'}</Text>
      </Box>
    )
  })
}
