import { expect, test } from 'vitest'

import { SEED_TIDBITS } from '../src/core/seeds'
import { addTidbits, refresh } from '../src/core/tidbits'
import type { Tidbit } from '../src/core/types'
import { fakeHost } from './fake-host'

test('tidbit research is told about every tip shown, waiting or seeded', async () => {
  const { host, runs } = fakeHost()
  // The CHANGELOG lane has just run, so research is next
  await host.global.set('tidbits:cursor', { changelogAt: host.now() })
  await host.global.set('tidbits', [{ id: 'research:1', headline: 'A tip waiting in the queue', lane: 'research' }])
  await host.global.set('tidbits:history', [
    { id: 'research:2', headline: 'A tip already shown', lane: 'research', shownAt: '2026-10-01T00:00:00.000Z' },
    { id: 'research:3', headline: 'a tip  already shown', lane: 'research', shownAt: '2026-10-02T00:00:00.000Z' },
  ])
  await refresh(host)

  const prompt = runs.find(r => r.argv[1] === '-p')!.argv[2]!
  expect(prompt).toContain("The developer already knows these tips. Don't return one that makes the same point, even from another source.")
  expect(prompt).toContain('- A tip waiting in the queue\n')
  expect(prompt.match(/already shown/gi)).toHaveLength(1)
  for (const seed of SEED_TIDBITS) expect(prompt).toContain(`- ${seed.headline}`)
})

test('tidbits from the same page are kept, but not the same line twice', async () => {
  const { host } = fakeHost()
  const tidbit = (headline: string, quote: string, lane: Tidbit['lane'] = 'research'): Tidbit => ({
    id: headline,
    headline,
    body: '',
    url: 'https://code.claude.com/docs/en/changelog',
    quote,
    topic: 'prompting',
    lane,
    isVerified: true,
  })
  const first = await addTidbits(host, [tidbit('One', 'Added `/one`'), tidbit('Two', 'Added `/two`')])
  expect(first.map(t => t.headline)).toEqual(['One', 'Two'])
  // The same line, quoted as rendered on the page rather than from the markdown
  const again = await addTidbits(host, [tidbit('One, reworded', 'Added /one'), tidbit('Three', 'Added `/three`', 'changelog')])
  expect(again.map(t => t.headline)).toEqual(['Three'])
})
