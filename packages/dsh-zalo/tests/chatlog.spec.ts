import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatLog, formatEntry, type ChatLogEntry } from '../src/chatlog.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'chatlog-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const entry = (minute: number, id: string, text = `t${minute}`): ChatLogEntry =>
  ({ ts: `2026-10-15T05:${String(minute).padStart(2, '0')}:00.000Z`, message_id: id, user_id: 'u1', name: 'Ann', text })

describe('ChatLog', () => {
  it('returns entries after a timestamp, minus the trigger, newest `limit`', async () => {
    const log = new ChatLog(dir)
    for (const [m, id] of [[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']] as const) await log.append('g1', entry(m, id))
    const recent = await log.recent('g1', entry(1, 'a').ts, 'd', 1)
    expect(recent.map(e => e.message_id)).toEqual(['c'])
  })

  it('filters history by timestamp and query', async () => {
    const log = new ChatLog(dir)
    await log.append('g1', entry(1, 'a', 'hello'))
    await log.append('g1', entry(2, 'b', 'world'))
    await log.append('g1', entry(3, 'c', 'Hello again'))
    const found = await log.history('g1', { limit: 10, before: entry(3, 'c').ts, query: 'HELLO' })
    expect(found.map(e => e.message_id)).toEqual(['a'])
  })

  it('stores a hostile chat id inside its directory', async () => {
    const log = new ChatLog(join(dir, 'log'))
    await log.append('../evil', entry(1, 'a'))
    expect(await readdir(join(dir, 'log'))).toEqual(['___evil.jsonl'])
  })

  it('trims to the newest maxEntries', async () => {
    const log = new ChatLog(dir, undefined, 2)
    for (let m = 1; m <= 5; m++) await log.append('c', entry(m, `m${m}`))
    expect((await log.readAll('c')).length).toBeLessThanOrEqual(2 * 1.2)
  })

  it('formats senders and folds newlines', () => {
    expect(formatEntry({ ...entry(1, 'a'), text: 'a\nb' })).toBe('[2026-10-15T05:01:00.000Z] id:u1 (Ann): a b')
    expect(formatEntry({ ...entry(1, 'a'), bot: true })).toContain('assistant: ')
  })
})
