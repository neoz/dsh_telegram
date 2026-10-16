import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'

const minimal = {
  botToken: '123:abc',
}

describe('Config', () => {
  it('fills defaults', () => {
    const config = Config(minimal)
    expect(config.messageSize).toBe(1024)
    expect(config.statusEditIntervalMs).toBe(1000)
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

  it('clamps messageSize to its range', () => {
    expect(() => Config({ ...minimal, messageSize: 500 })).toThrow()
    expect(() => Config({ ...minimal, messageSize: 5000 })).toThrow()
  })

  it('leaves paths, model, memory, the allowlist and turn limits to dsh-chat', () => {
    const config = Config(minimal)
    for (const key of ['workspaceRoot', 'dataDir', 'model', 'provider', 'memory', 'fileRetentionDays', 'chatLogMaxEntries', 'allowFrom', 'superAdmins', 'recentMessagesLimit', 'turnTimeoutMs']) expect(config).not.toHaveProperty(key)
    expect(config).not.toHaveProperty('idle')
  })
})
