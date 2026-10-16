import { describe, expect, it } from 'vitest'
import { assertConfig, Config } from '../src/config.ts'

const base = { botToken: 't', allowFrom: ['u1'] }

describe('Config', () => {
  it('fills defaults', () => {
    const config = Config(base)
    expect(config).toMatchObject({
      groupPrefix: '/ask', messageSize: 2000, pollTimeoutSec: 30,
      typingIntervalMs: 4000, recentMessagesLimit: 30, turnTimeoutMs: 900_000,
      superAdmins: [], maxDownloadMb: 20,
      retry: { maxAttempts: 4, startDelayMs: 500, maxDelayMs: 8000 },
    })
    for (const key of ['workspaceRoot', 'dataDir', 'model', 'provider', 'memory', 'fileRetentionDays', 'chatLogMaxEntries']) expect(config).not.toHaveProperty(key)
  })
  it('caps messageSize at the Zalo limit', () => {
    expect(() => Config({ ...base, messageSize: 2001 })).toThrow()
  })
  it('requires a non-empty allowlist', () => {
    expect(() => assertConfig(Config({ ...base, allowFrom: [] }))).toThrow(/allowFrom/)
    expect(() => assertConfig(Config(base))).not.toThrow()
  })
})
