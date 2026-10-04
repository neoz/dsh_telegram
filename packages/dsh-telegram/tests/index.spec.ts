import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatLog } from '../src/chatlog.ts'
import { forwardAppends } from '../src/index.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'index-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('forwardAppends', () => {
  it('keeps a throwing telegram/message listener from failing the chat-log write', async () => {
    const warns: string[] = []
    const log = new ChatLog(dir, forwardAppends(() => { throw new Error('boom') }, m => warns.push(m)))
    await log.append(5, { ts: '2026-10-04T05:00:00Z', message_id: 1, user_id: 7, name: 'Ann', text: 'hi' })
    expect(await log.readAll(5)).toHaveLength(1)
    expect(warns[0]).toMatch(/telegram\/message listener failed: boom/)
  })
})
