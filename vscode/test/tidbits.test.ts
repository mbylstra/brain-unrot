import { expect, test } from 'vitest'

import { SEED_TIDBITS } from '../src/core/seeds'
import { refresh } from '../src/core/tidbits'
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
