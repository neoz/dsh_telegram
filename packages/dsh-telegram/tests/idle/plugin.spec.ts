import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatLog } from '../../src/chatlog.ts'
import * as idlePlugin from '../../src/idle/index.ts'
import { assertIdleConfig, Config } from '../../src/idle/index.ts'
import type { TelegramService } from '../../src/service.ts'
import { FakeTelegramApi } from '../helpers/fake-api.ts'

describe('idle Config', () => {
  it('fills idle defaults with idle disabled', () => {
    expect(Config({})).toEqual({
      enabled: false,
      chatIds: [],
      idleMinutes: 60,
      minNewMessages: 5,
      chance: 0.3,
      checkIntervalMinutes: 10,
      maxPerDay: 5,
      quietHours: { from: 23, to: 7 },
      timezone: 'Asia/Ho_Chi_Minh',
      contextMessages: 20,
      persona: '',
    })
  })

  it('accepts partial idle overrides', () => {
    const idle = Config({ enabled: true, chatIds: [-1001234567890], quietHours: { from: 0 } })
    expect(idle.enabled).toBe(true)
    expect(idle.chatIds).toEqual([-1001234567890])
    expect(idle.quietHours).toEqual({ from: 0, to: 7 })
    expect(idle.chance).toBe(0.3)
  })

  it('rejects an idle chance above 1', () => {
    expect(() => Config({ chance: 1.5 })).toThrow()
  })

  it('rejects an unknown idle timezone', () => {
    expect(() => assertIdleConfig(Config({ timezone: 'Mars/Olympus' }))).toThrow(/idle.timezone/)
  })
})

/** `FiberState` is a const enum that Cordis does not export at runtime. */
const ACTIVE = 2
const FAILED = 3

describe('idle plugin', () => {
  const A = -5
  const B = -6
  /** Engages on every tick once a chat has a fresh human message: no quiet hours, chance 1. */
  const config = Config({
    enabled: true, chatIds: [A, B], idleMinutes: 1, minNewMessages: 1, chance: 1,
    checkIntervalMinutes: 1, quietHours: { from: 0, to: 0 },
  })
  let dir: string
  let chatLog: ChatLog
  let queued: Array<{ chatId: number; task: () => Promise<void> }>
  let calls: GenerateOptions[]
  let root: Context
  let baseline: number

  function service(): TelegramService {
    return {
      api: new FakeTelegramApi(),
      chatLog,
      queue: { enqueue: (chatId, task) => { queued.push({ chatId, task }) }, isBusy: () => false },
      bot: { id: 1, username: 'dshbot' },
      selection: { provider: 'p', model: 'm' },
    }
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    dir = await mkdtemp(join(tmpdir(), 'idle-plugin-'))
    chatLog = new ChatLog(join(dir, 'log'))
    const ts = new Date(Date.now() - 30_000).toISOString()
    for (const [chatId, id] of [[A, 10], [B, 20]] as const) {
      await chatLog.append(chatId, { ts, message_id: id, user_id: 7, username: 'ann', name: 'Ann', text: 'hi' })
    }
    queued = []
    calls = []
    root = new Context()
    root.provide('llm', {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        calls.push(options)
        yield { type: 'text-delta', index: 0, text: '{"action":"skip"}' }
        yield { type: 'finish', reason: { kind: 'stop' } } as never
      },
    })
    baseline = vi.getTimerCount()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await rm(dir, { recursive: true, force: true })
  })

  it('stays inert without the telegram service', async () => {
    root.plugin(idlePlugin, config)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(vi.getTimerCount()).toBe(baseline)
  })

  it('loads but starts no timer when disabled', async () => {
    const fiber = root.plugin(idlePlugin, { ...config, enabled: false })
    root.provide('telegram', service())
    await vi.waitFor(() => expect(fiber.state).toBe(ACTIVE))
    expect(vi.getTimerCount()).toBe(baseline)
  })

  it('rejects an invalid config at load, before the bot provides telegram', async () => {
    const badZone = root.plugin(idlePlugin, { ...config, timezone: 'Mars/Olympus' })
    const badChance = root.plugin(idlePlugin, { ...config, chance: 1.5 })
    await vi.waitFor(() => expect([badZone.state, badChance.state]).toEqual([FAILED, FAILED]))
  })

  it('logs once that idle engagement is on', async () => {
    const lines: string[] = []
    root.logger.exporter({ levels: { default: 3 }, export: message => lines.push(String(message.args[0])) })
    root.plugin(idlePlugin, config)
    root.provide('telegram', service())
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(baseline + 1))
    expect(lines.filter(line => line.includes('idle engagement on for 2 chat(s)'))).toHaveLength(1)
  })

  it('starts the scheduler once telegram is provided and skips a chat that just had a turn', async () => {
    root.plugin(idlePlugin, config)
    root.provide('telegram', service())
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(baseline + 1))
    root.emit('telegram/turn', A)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(queued.map(q => q.chatId)).toContain(B))
    expect(queued.map(q => q.chatId)).toEqual([B])
  })

  it('stops on revoke, so a task queued before it never calls the model', async () => {
    root.plugin(idlePlugin, config)
    const revoke = root.provide('telegram', service())
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(baseline + 1))
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(queued).toHaveLength(2))
    revoke()
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(baseline))
    for (const { task } of queued) await task()
    expect(calls).toHaveLength(0)
  })

  it('restarts after a revoke and a new provide', async () => {
    root.plugin(idlePlugin, config)
    const revoke = root.provide('telegram', service())
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(baseline + 1))
    revoke()
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(baseline))
    root.provide('telegram', service())
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(baseline + 1))
  })
})
