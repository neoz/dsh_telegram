import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { FakeZaloApi } from './helpers/fake-api.ts'

const order: string[] = []

vi.mock('../src/zalo-api.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/zalo-api.ts')>(),
  createZaloApi: () => new FakeZaloApi(),
}))
vi.mock('../src/poller.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/poller.ts')>(),
  startPolling: () => {
    order.push('poll')
    return { stop: async () => {} }
  },
}))

describe('dsh-zalo start', () => {
  it('registers its channel before polling starts, so the first update is never dropped as offline', async () => {
    const zalo = await import('../src/index.ts')
    const root = new Context()
    root.provide('loader', { await: async () => {} } as never)
    root.provide('chatAgents', { workspaceFor: () => '/w' } as never)
    root.provide('chat', { register: () => { order.push('register'); return () => {} }, inbound: () => {} } as never)
    root.plugin(zalo, zalo.Config({ botToken: 't' }))
    await vi.waitFor(() => expect(order).toContain('poll'))
    expect(order).toEqual(['register', 'poll'])
  })
})
