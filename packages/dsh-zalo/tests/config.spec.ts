import { describe, expect, it } from 'vitest'
import { assertConfig, Config } from '../src/config.ts'

const base = { botToken: 't', allowFrom: ['u1'], workspaceRoot: '/w', dataDir: '/d', model: 'm' }

describe('Config', () => {
  it('fills defaults', () => {
    const config = Config(base)
    expect(config).toMatchObject({
      provider: 'deepseek-official', groupPrefix: '/ask', messageSize: 2000, pollTimeoutSec: 30,
      typingIntervalMs: 4000, recentMessagesLimit: 30, turnTimeoutMs: 900_000, fileRetentionDays: 90,
      chatLogMaxEntries: 15_000, superAdmins: [],
      retry: { maxAttempts: 4, startDelayMs: 500, maxDelayMs: 8000 },
      memory: { maxEntries: 50, maxGlobalEntries: 50, maxEntryChars: 200 },
    })
  })
  it('caps messageSize at the Zalo limit', () => {
    expect(() => Config({ ...base, messageSize: 2001 })).toThrow()
  })
  it('requires a non-empty allowlist and absolute paths', () => {
    expect(() => assertConfig(Config({ ...base, allowFrom: [] }))).toThrow(/allowFrom/)
    expect(() => assertConfig(Config({ ...base, dataDir: 'data' }))).toThrow(/dataDir/)
    expect(() => assertConfig(Config(base))).not.toThrow()
  })
})
