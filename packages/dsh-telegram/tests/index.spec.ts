import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatLog } from '../src/chatlog.ts'
import { forwardAppends, retryStart } from '../src/index.ts'

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

describe('retryStart', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('retries a failed start with a doubling delay capped at the maximum, then hands over the result', async () => {
    let calls = 0
    const start = async () => { calls++; if (calls < 5) throw new Error(`fail ${calls}`); return 'bot' }
    const delays: number[] = []
    const started: string[] = []
    retryStart(start, r => started.push(r), (_, delayMs) => delays.push(delayMs), { startDelayMs: 100, maxDelayMs: 300 })
    await vi.runAllTimersAsync()
    expect(delays).toEqual([100, 200, 300, 300])
    expect(started).toEqual(['bot'])
  })

  it('stops retrying once cancelled', async () => {
    let calls = 0
    const start = async () => { calls++; throw new Error('down') }
    const cancel = retryStart(start, () => {}, () => {}, { startDelayMs: 100, maxDelayMs: 100 })
    await vi.advanceTimersByTimeAsync(0)
    cancel()
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(1)
  })
})
