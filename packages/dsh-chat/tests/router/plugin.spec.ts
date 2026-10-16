import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as chat from '../../src/index.ts'

describe('dsh-chat router plugin', () => {
  it('defaults the turn limits and requires allowFrom', () => {
    expect(chat.Config({ allowFrom: ['zalo:1'] })).toEqual({ allowFrom: ['zalo:1'], superAdmins: [], recentMessagesLimit: 30, turnTimeoutMs: 900_000 })
    expect(() => chat.Config({})).toThrow()
  })

  it('rejects an empty allowFrom and entries that are not user keys', () => {
    expect(() => chat.assertRouterConfig(chat.Config({ allowFrom: [] }))).toThrow('allowFrom')
    expect(() => chat.assertRouterConfig(chat.Config({ allowFrom: ['12345'] }))).toThrow('12345')
    expect(() => chat.assertRouterConfig(chat.Config({ allowFrom: ['zalo:1'], superAdmins: ['7'] }))).toThrow('7')
  })

  it('provides chat once its stores are up', async () => {
    const root = new Context()
    root.plugin(chat, chat.Config({ allowFrom: ['zalo:1'] }))
    expect(root.get('chat')).toBeUndefined()
    root.provide('chatLog', {} as never)
    root.provide('chatMemory', {} as never)
    root.provide('chatAgents', {} as never)
    root.provide('attachments', {} as never)
    await vi.waitFor(() => expect(root.get('chat')).toBeInstanceOf(chat.ChatRouter))
  })
})
