import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { FakeTelegramApi } from './helpers/fake-api.ts'

const order: string[] = []

vi.mock('grammy', () => ({
  Bot: class {
    api = { config: { use: () => {} } }
    botInfo = { id: 1, username: 'dshbot' }
    async init() {}
    on() {}
    catch() {}
  },
}))
vi.mock('@grammyjs/runner', () => ({
  run: () => {
    order.push('poll')
    return { task: () => undefined, isRunning: () => false, stop: async () => {} }
  },
}))
vi.mock('../src/telegram-api.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/telegram-api.ts')>(),
  createGrammyApi: () => new FakeTelegramApi(),
}))

describe('dsh-telegram start', () => {
  it('registers its channel before polling starts, so the first update is never dropped as offline', async () => {
    const telegram = await import('../src/index.ts')
    const root = new Context()
    root.provide('loader', { await: async () => {} } as never)
    root.provide('chatData', { dataDir: '/d', workspaceRoot: '/w' } as never)
    root.provide('chatLog', {} as never)
    root.provide('chatAgents', { workspaceFor: () => '/w', selection: { provider: 'p', model: 'm' } } as never)
    root.provide('chat', { register: () => { order.push('register'); return () => {} }, inbound: () => {}, superAdmins: [] } as never)
    root.plugin(telegram, telegram.Config({ botToken: 't' }))
    await vi.waitFor(() => expect(order).toContain('poll'))
    expect(order).toEqual(['register', 'poll'])
  })
})
