import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SessionMap } from '../src/session-map.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'map-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('persists string chat ids across loads', async () => {
  const file = join(dir, 'zalo-sessions.json')
  const map = new SessionMap(file)
  await map.load()
  await map.set('6ede9afa', { sessionId: 's1', lastTurnAt: '' })
  const again = new SessionMap(file)
  await again.load()
  expect(again.get('6ede9afa')).toEqual({ sessionId: 's1', lastTurnAt: '' })
  await again.delete('6ede9afa')
  expect(again.get('6ede9afa')).toBeUndefined()
})
