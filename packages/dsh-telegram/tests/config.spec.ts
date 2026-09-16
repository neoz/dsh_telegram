import { describe, expect, it } from 'vitest'
import { Config, assertConfig } from '../src/config.ts'

const minimal = {
  botToken: '123:abc',
  allowFrom: ['42'],
  workspaceRoot: '/workspace',
  dataDir: '/data',
  model: 'deepseek-v4-flash',
}

describe('Config', () => {
  it('fills defaults', () => {
    const config = Config(minimal)
    expect(config.provider).toBe('deepseek-official')
    expect(config.messageSize).toBe(1024)
    expect(config.recentMessagesLimit).toBe(30)
    expect(config.statusEditIntervalMs).toBe(1000)
    expect(config.turnTimeoutMs).toBe(900_000)
    expect(config.pollRetryMs).toBe(86_400_000)
    expect(config.retry).toEqual({ maxAttempts: 4, startDelayMs: 500, maxDelayMs: 8000, maxUploadMb: 20 })
  })

  it('rejects a missing bot token', () => {
    expect(() => Config({ ...minimal, botToken: undefined })).toThrow()
  })

  it('rejects an empty allow list', () => {
    expect(() => assertConfig(Config({ ...minimal, allowFrom: [] }))).toThrow()
  })

  it('rejects a relative workspace root', () => {
    expect(() => assertConfig(Config({ ...minimal, workspaceRoot: 'relative' }))).toThrow(/absolute/)
  })

  it('clamps messageSize to its range', () => {
    expect(() => Config({ ...minimal, messageSize: 500 })).toThrow()
    expect(() => Config({ ...minimal, messageSize: 5000 })).toThrow()
  })
})
