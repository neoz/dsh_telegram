import { describe, expect, it, vi } from 'vitest'
import { SeenIds, startPolling } from '../src/poller.ts'
import type { ZaloUpdate } from '../src/zalo-api.ts'

const update = (id: string): ZaloUpdate => ({
  event_name: 'message.text.received',
  message: { message_id: id, date: 0, from: { id: 'u' }, chat: { id: 'c', chat_type: 'PRIVATE' }, text: id },
})
const log = { warn: vi.fn(), error: vi.fn() }

/** getUpdates that serves the given batches, then blocks until aborted. */
function scripted(batches: Array<ZaloUpdate[] | Error>) {
  return {
    getUpdates: vi.fn((_t: number, signal?: AbortSignal) => {
      const next = batches.shift()
      if (next instanceof Error) return Promise.reject(next)
      if (next !== undefined) return Promise.resolve(next)
      return new Promise<ZaloUpdate[]>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }),
  }
}

describe('SeenIds', () => {
  it('reports new ids once and forgets the oldest past the limit', () => {
    const seen = new SeenIds(2)
    expect(seen.add('a')).toBe(true)
    expect(seen.add('a')).toBe(false)
    seen.add('b')
    seen.add('c')
    expect(seen.add('a')).toBe(true)
  })
})

describe('startPolling', () => {
  it('delivers each message once and skips updates without a message', async () => {
    const got: string[] = []
    const api = scripted([[update('1'), update('2')], [update('2'), { event_name: 'x' } as never, update('3')]])
    const poller = startPolling({ api, timeoutSec: 30, onUpdate: u => got.push(u.message.message_id), backoff: { startDelayMs: 0, maxDelayMs: 0 }, log })
    await vi.waitFor(() => expect(got).toEqual(['1', '2', '3']))
    await poller.stop()
  })

  it('backs off after a failure and keeps polling', async () => {
    const got: string[] = []
    const api = scripted([new Error('down'), [update('1')]])
    const poller = startPolling({ api, timeoutSec: 30, onUpdate: u => got.push(u.message.message_id), backoff: { startDelayMs: 1, maxDelayMs: 1 }, log })
    await vi.waitFor(() => expect(got).toEqual(['1']))
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('dsh-zalo: getUpdates failed (down)'))
    await poller.stop()
  })

  it('stop() aborts the pending long poll and resolves promptly', async () => {
    const api = scripted([])
    const poller = startPolling({ api, timeoutSec: 30, onUpdate: () => {}, backoff: { startDelayMs: 0, maxDelayMs: 0 }, log })
    await vi.waitFor(() => expect(api.getUpdates).toHaveBeenCalled())
    await expect(poller.stop()).resolves.toBeUndefined()
  })

  it('keeps polling when a handler throws', async () => {
    const got: string[] = []
    const api = scripted([[update('1')], [update('2')]])
    const poller = startPolling({
      api, timeoutSec: 30, backoff: { startDelayMs: 0, maxDelayMs: 0 }, log,
      onUpdate: (u) => { got.push(u.message.message_id); if (u.message.message_id === '1') throw new Error('bad') },
    })
    await vi.waitFor(() => expect(got).toEqual(['1', '2']))
    await poller.stop()
  })
})
