import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { name, retryStart } from '../src/index.ts'

it('is named dsh-zalo', () => { expect(name).toBe('dsh-zalo') })

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
