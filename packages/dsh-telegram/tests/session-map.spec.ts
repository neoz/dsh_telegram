import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionMap } from '../src/session-map.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sessmap-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('SessionMap', () => {
  it('starts empty when the file is missing', async () => {
    const map = new SessionMap(join(dir, 'map.json'))
    await map.load()
    expect(map.get(1)).toBeUndefined()
  })

  it('persists set and delete across instances', async () => {
    const file = join(dir, 'map.json')
    const a = new SessionMap(file)
    await a.load()
    await a.set(1, { sessionId: 's1', lastTurnMessageId: 10 })
    await a.set(2, { sessionId: 's2', lastTurnMessageId: 0 })
    await a.delete(2)
    const b = new SessionMap(file)
    await b.load()
    expect(b.get(1)).toEqual({ sessionId: 's1', lastTurnMessageId: 10 })
    expect(b.get(2)).toBeUndefined()
    expect(await readdir(dir)).toEqual(['map.json'])
  })

  it('creates the parent directory', async () => {
    const map = new SessionMap(join(dir, 'nested', 'map.json'))
    await map.load()
    await map.set(1, { sessionId: 's1', lastTurnMessageId: 0 })
    expect(map.get(1)?.sessionId).toBe('s1')
  })
})
