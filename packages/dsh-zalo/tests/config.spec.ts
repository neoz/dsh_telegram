import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'

const base = { botToken: 't' }

describe('Config', () => {
  it('fills defaults', () => {
    const config = Config(base)
    expect(config).toMatchObject({
      groupPrefix: '/ask', messageSize: 2000, pollTimeoutSec: 30,
      typingIntervalMs: 4000, maxDownloadMb: 20, stickers: {},
      retry: { maxAttempts: 4, startDelayMs: 500, maxDelayMs: 8000 },
    })
    for (const key of ['workspaceRoot', 'dataDir', 'model', 'provider', 'memory', 'fileRetentionDays', 'chatLogMaxEntries', 'allowFrom', 'superAdmins', 'recentMessagesLimit', 'turnTimeoutMs']) expect(config).not.toHaveProperty(key)
  })
  it('caps messageSize at the Zalo limit', () => {
    expect(() => Config({ ...base, messageSize: 2001 })).toThrow()
  })
})
