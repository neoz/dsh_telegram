import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatLog } from '../src/chatlog.ts'
import { forwardAppends, name, retryStart } from '../src/index.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'index-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('is named dsh-zalo', () => { expect(name).toBe('dsh-zalo') })

describe('forwardAppends', () => {
  it('keeps a throwing zalo/message listener from failing the chat-log write', async () => {
    const warns: string[] = []
    const log = new ChatLog(dir, forwardAppends(() => { throw new Error('boom') }, m => warns.push(m)))
    await log.append('c', { ts: '2026-10-15T05:00:00.000Z', message_id: 'a', user_id: 'u', name: 'Ann', text: 'hi' })
    expect(await log.readAll('c')).toHaveLength(1)
    expect(warns[0]).toMatch(/zalo\/message listener failed: boom/)
  })
})

describe('retryStart', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  it('retries with a doubling, capped delay and hands over the result', async () => {
    let calls = 0
    const delays: number[] = []
    const started: string[] = []
    retryStart(async () => { calls++; if (calls < 4) throw new Error('x'); return 'bot' }, r => started.push(r), (_, d) => delays.push(d), { startDelayMs: 100, maxDelayMs: 300 })
    await vi.runAllTimersAsync()
    expect(delays).toEqual([100, 200, 300])
    expect(started).toEqual(['bot'])
  })
})
