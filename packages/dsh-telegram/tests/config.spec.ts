import { describe, expect, it } from 'vitest'
import { Config, assertConfig } from '../src/config.ts'

const minimal = {
  botToken: '123:abc',
  allowFrom: ['42'],
}

describe('Config', () => {
  it('fills defaults', () => {
    const config = Config(minimal)
    expect(config.messageSize).toBe(1024)
    expect(config.recentMessagesLimit).toBe(30)
    expect(config.statusEditIntervalMs).toBe(1000)
    expect(config.turnTimeoutMs).toBe(900_000)
    expect(config.pollRetryMs).toBe(86_400_000)
    expect(config.retry).toEqual({ maxAttempts: 4, startDelayMs: 500, maxDelayMs: 8000, maxUploadMb: 20 })
    expect(config.status).toEqual({
      thinking: 'Thinking...',
      web: 'Searching the web...',
      read: 'Reading files...',
      write: 'Editing files...',
      command: 'Running a command...',
      send: 'Sending a file...',
      other: 'Working...',
    })
  })

  it('accepts partial status overrides', () => {
    const config = Config({ ...minimal, status: { thinking: 'Hmm...' } })
    expect(config.status.thinking).toBe('Hmm...')
    expect(config.status.other).toBe('Working...')
  })

  it('rejects a missing bot token', () => {
    expect(() => Config({ ...minimal, botToken: undefined })).toThrow()
  })

  it('rejects an empty allow list', () => {
    expect(() => assertConfig(Config({ ...minimal, allowFrom: [] }))).toThrow()
  })

  it('clamps messageSize to its range', () => {
    expect(() => Config({ ...minimal, messageSize: 500 })).toThrow()
    expect(() => Config({ ...minimal, messageSize: 5000 })).toThrow()
  })

  it('defaults superAdmins to nobody and leaves paths, model and memory to dsh-chat', () => {
    const config = Config(minimal)
    expect(config.superAdmins).toEqual([])
    for (const key of ['workspaceRoot', 'dataDir', 'model', 'provider', 'memory', 'fileRetentionDays', 'chatLogMaxEntries']) expect(config).not.toHaveProperty(key)
    expect(config).not.toHaveProperty('idle')
  })

  it('accepts super admin ids', () => {
    expect(Config({ ...minimal, superAdmins: [42, 7] }).superAdmins).toEqual([42, 7])
  })
})
