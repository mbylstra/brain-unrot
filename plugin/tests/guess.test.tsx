import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'brain-unrot',
  component: 'Pane',
  requestId: 'brain-unrot',
  props: {
    title: 'Brain Unrot',
    isFocused: true,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('a prompt starts a round, a guess is judged, and it can be replayed', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.prompt.submit({ text: 'do a thing', wait: false, origin: { kind: 'composer' } })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /Which one/ }))?.text).toContain('Which one')
    await ui.press({ key: 'guess-1' })
    const verdict = await ui.find({ type: 'Text', text: /Correct|Wrong/ })
    expect(verdict?.text).toMatch(/^(Correct!|Wrong — it was [234]\.)$/)

    await ui.press({ key: 'again' })
    expect((await ui.find({ type: 'Text', text: /Which one/ }))?.text).toContain('Which one')
    await ui.unmount()
  }
})
