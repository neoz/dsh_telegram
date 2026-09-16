import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatLog, formatEntry, senderLabel, type ChatLogEntry } from '../src/chatlog.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'chatlog-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function entry(id: number, text: string, extra: Partial<ChatLogEntry> = {}): ChatLogEntry {
  return { ts: `2026-09-16T00:00:${String(id).padStart(2, '0')}Z`, message_id: id, user_id: 7, name: 'Ann', text, ...extra }
}

describe('ChatLog', () => {
  it('appends one JSON line per entry', async () => {
    const log = new ChatLog(dir)
    await log.append(5, entry(1, 'hi'))
    await log.append(5, entry(2, 'there'))
    const raw = await readFile(join(dir, '5.jsonl'), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(2)
    expect(await log.readAll(5)).toHaveLength(2)
  })

  it('reads an empty log for an unknown chat', async () => {
    expect(await new ChatLog(dir).readAll(99)).toEqual([])
  })

  it('recent returns messages after the anchor, excluding the trigger, newest-limited', async () => {
    const log = new ChatLog(dir)
    for (let i = 1; i <= 6; i++) await log.append(1, entry(i, `m${i}`))
    const got = await log.recent(1, 2, 6, 2)
    expect(got.map(e => e.message_id)).toEqual([4, 5])
  })

  it('history reads backwards with limit, before and query filters', async () => {
    const log = new ChatLog(dir)
    for (let i = 1; i <= 10; i++) await log.append(1, entry(i, i % 2 ? `odd ${i}` : `even ${i}`))
    expect((await log.history(1, { limit: 3 })).map(e => e.message_id)).toEqual([8, 9, 10])
    expect((await log.history(1, { limit: 3, beforeMessageId: 5 })).map(e => e.message_id)).toEqual([2, 3, 4])
    expect((await log.history(1, { limit: 2, query: 'ODD' })).map(e => e.message_id)).toEqual([7, 9])
  })
})

describe('labels', () => {
  it('prefers username, falls back to id, marks the bot', () => {
    expect(senderLabel({ user_id: 7, username: 'ann', name: 'Ann' })).toBe('@ann (Ann)')
    expect(senderLabel({ user_id: 7, name: 'Ann' })).toBe('id:7 (Ann)')
    expect(senderLabel({ user_id: 1, name: 'Bot', bot: true })).toBe('assistant')
  })
  it('formats one line', () => {
    expect(formatEntry(entry(3, 'hello', { username: 'ann' }))).toBe('[2026-09-16T00:00:03Z] @ann (Ann): hello')
  })
})
