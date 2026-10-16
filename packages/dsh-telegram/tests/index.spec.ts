import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { retryStart } from '../src/index.ts'

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
