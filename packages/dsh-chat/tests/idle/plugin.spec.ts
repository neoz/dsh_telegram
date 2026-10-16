import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as idlePlugin from '../../src/idle/index.ts'
import { assertIdleConfig, Config } from '../../src/idle/index.ts'
import { chatKey } from '../../src/keys.ts'
import { ChatLog } from '../../src/log/chatlog.ts'
import { FakeChannel } from '../router/fake-channel.ts'

describe('idle Config', () => {
  it('fills idle defaults with idle disabled', () => {
    expect(Config({})).toEqual({
      enabled: false,
      chatKeys: [],
      idleMinutes: 60,
      minNewMessages: 5,
      chance: 0.3,
      hotWindowMinutes: 5,
      burstGapMinutes: 15,
      maxPerBurst: 1,
      slotGapMinutes: 5,
      maxPerDay: 5,
      quietHours: { from: 23, to: 7 },
      timezone: 'Asia/Ho_Chi_Minh',
      contextMessages: 20,
      persona: '',
    })
  })

  it('accepts partial idle overrides', () => {
    const idle = Config({ enabled: true, chatKeys: ['telegram:-1001234567890'], quietHours: { from: 0 } })
    expect(idle.enabled).toBe(true)
    expect(idle.chatKeys).toEqual(['telegram:-1001234567890'])
    expect(idle.quietHours).toEqual({ from: 0, to: 7 })
    expect(idle.chance).toBe(0.3)
  })

  it('rejects an idle chance above 1', () => {
    expect(() => Config({ chance: 1.5 })).toThrow()
  })

  it('rejects an unknown idle timezone and a bare chat id', () => {
    expect(() => assertIdleConfig(Config({ timezone: 'Mars/Olympus' }))).toThrow(/idle.timezone/)
    expect(() => assertIdleConfig(Config({ chatKeys: ['-5'] }))).toThrow(/chatKeys/)
  })
})

/** `FiberState` is a const enum that Cordis does not export at runtime. */
const ACTIVE = 2
const FAILED = 3

describe('idle plugin', () => {
  const A = chatKey('telegram', -5)
  const config = Config({ enabled: true, chatKeys: [A], idleMinutes: 1, minNewMessages: 5, chance: 1, quietHours: { from: 0, to: 0 } })
  let dir: string
  let root: Context
  let chatLog: ChatLog
  let queued: string[]

  const chat = () => ({ channel: () => new FakeChannel('telegram'), enqueue: (key: string) => { queued.push(key) } })
  async function burst(): Promise<void> {
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      await chatLog.append(A, { ts: new Date(now - (5 - i) * 1000).toISOString(), message_id: String(10 + i), user_id: i % 2 === 0 ? '7' : '8', name: 'U', text: 'hi' })
    }
  }
  const decisionsFile = () => join(dir, 'telegram', 'idle-decisions.jsonl')

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'idle-plugin-'))
    queued = []
    root = new Context()
    // dsh-chat/log wires the chat log to chat/message the same way.
    chatLog = new ChatLog(join(dir, 'log'), (key, entry) => root.emit('chat/message', key, entry))
    root.provide('llm', { async *stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } as never } } as never)
    root.provide('attachments', { saveImages: async () => [] } as never)
    root.provide('chatLog', chatLog)
    root.provide('chatAgents', { selection: { provider: 'p', model: 'm' } } as never)
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  async function started(dataDir = dir): Promise<() => void> {
    root.plugin(idlePlugin, config)
    root.provide('chatData', { dataDir, workspaceRoot: dir })
    const revoke = root.provide('chat', chat() as never)
    if (dataDir === dir) {
      await vi.waitFor(async () => {
        // The start record is written once the windows are seeded, so messages from here on are evaluated.
        expect(await readFile(decisionsFile(), 'utf8')).toContain('"event":"start"')
      })
    }
    return revoke
  }

  it('stays inert without the chat service', async () => {
    root.plugin(idlePlugin, config)
    root.provide('chatData', { dataDir: dir, workspaceRoot: dir })
    await burst()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(queued).toEqual([])
  })

  it('loads but does nothing when disabled', async () => {
    const fiber = root.plugin(idlePlugin, { ...config, enabled: false })
    root.provide('chatData', { dataDir: dir, workspaceRoot: dir })
    root.provide('chat', chat() as never)
    await vi.waitFor(() => expect(fiber.state).toBe(ACTIVE))
    await burst()
    expect(queued).toEqual([])
  })

  it('rejects an invalid config at load, before the router is up', async () => {
    const badZone = root.plugin(idlePlugin, { ...config, timezone: 'Mars/Olympus' })
    const badChance = root.plugin(idlePlugin, { ...config, chance: 1.5 })
    const badKey = root.plugin(idlePlugin, { ...config, chatKeys: ['-5'] })
    await vi.waitFor(() => expect([badZone.state, badChance.state, badKey.state]).toEqual([FAILED, FAILED, FAILED]))
  })

  it('queues an engagement when lines written through chatLog make a burst hot', async () => {
    await started()
    await burst()
    expect(queued).toEqual([A])
  })

  it('a turn noted through chat/turn keeps the bot from joining', async () => {
    await started()
    root.emit('chat/turn', A)
    await burst()
    expect(queued).toEqual([])
  })

  it('ignores lines and turns of chats it does not serve', async () => {
    await started()
    root.emit('chat/turn', 'zalo:-5')
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      await chatLog.append('zalo:-5', { ts: new Date(now - (5 - i) * 1000).toISOString(), message_id: String(10 + i), user_id: i % 2 === 0 ? '7' : '8', name: 'U', text: 'hi' })
    }
    expect(queued).toEqual([])
  })

  it('stops listening on revoke and starts again on a new provide', async () => {
    const revoke = await started()
    revoke()
    await burst()
    expect(queued).toEqual([])
    root.provide('chat', chat() as never)
    await vi.waitFor(async () => {
      expect((await readFile(decisionsFile(), 'utf8')).match(/"event":"start"/g)).toHaveLength(2)
    })
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      await chatLog.append(A, { ts: new Date(now + i).toISOString(), message_id: String(50 + i), user_id: i % 2 === 0 ? '7' : '8', name: 'U', text: 'again' })
    }
    expect(queued).toEqual([A])
  })

  it('logs once that idle engagement is on', async () => {
    const lines: string[] = []
    root.logger.exporter({ levels: { default: 3 }, export: message => lines.push(String(message.args[0])) })
    await started()
    expect(lines.filter(line => line.includes('idle engagement on for 1 chat(s)'))).toHaveLength(1)
  })

  it('only warns when the decision log cannot be written', async () => {
    const warnings: string[] = []
    root.logger.exporter({ levels: { default: 3 }, export: message => { if (message.type === 'warn') warnings.push(String(message.args[0])) } })
    await writeFile(join(dir, 'blocker'), 'x')
    await started(join(dir, 'blocker'))
    // The failed write is the start record, which comes after seeding.
    await vi.waitFor(() => expect(warnings.some(w => w.includes('idle-decisions.jsonl'))).toBe(true))
    await burst()
    expect(queued).toEqual([A])
  })
})
