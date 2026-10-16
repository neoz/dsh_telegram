import { describe, expect, it, vi } from 'vitest'
import { ChatQueue } from '../../src/router/queue.ts'

describe('ChatQueue', () => {
  it('runs tasks of one key in order and tasks of other keys alongside', async () => {
    const queue = new ChatQueue(() => {})
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    queue.enqueue('telegram:5', async () => { await held; order.push('a1') })
    queue.enqueue('telegram:5', async () => { order.push('a2') })
    queue.enqueue('zalo:5', async () => { order.push('b1') })
    await vi.waitFor(() => expect(order).toEqual(['b1']))
    expect(queue.isBusy('telegram:5')).toBe(true)
    release()
    await vi.waitFor(() => expect(order).toEqual(['b1', 'a1', 'a2']))
    await vi.waitFor(() => expect(queue.isBusy('telegram:5')).toBe(false))
  })

  it('reports a failing task and still runs the next one', async () => {
    const errors: string[] = []
    const queue = new ChatQueue((key, error) => errors.push(`${key} ${(error as Error).message}`))
    const ran: string[] = []
    queue.enqueue('zalo:1', async () => { throw new Error('boom') })
    queue.enqueue('zalo:1', async () => { ran.push('next') })
    await vi.waitFor(() => expect(ran).toEqual(['next']))
    expect(errors).toEqual(['zalo:1 boom'])
  })
})
