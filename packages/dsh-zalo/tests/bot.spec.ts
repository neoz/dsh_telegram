import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commandOf, createDispatcher, gate, handleMessage, isAllowed, type BotDeps } from '../src/bot.ts'
import { ChatLog } from '../src/chatlog.ts'
import { Config } from '../src/config.ts'
import { MemoryStore } from '../src/memory.ts'
import type { ZaloUpdate } from '../src/zalo-api.ts'
import { FakeZaloApi } from './helpers/fake-api.ts'

const ann = { id: 'ann', display_name: 'Ann', is_bot: false }
const bob = { id: 'bob', display_name: 'Bob', is_bot: false }
let seq = 0
function upd(text: string, chatType: 'PRIVATE' | 'GROUP' = 'PRIVATE', from = ann): ZaloUpdate {
  seq++
  return {
    event_name: 'message.text.received',
    message: { message_id: `id${seq}`, date: Date.UTC(2026, 9, 15, 5, seq), from, chat: { id: chatType === 'GROUP' ? 'g1' : 'p1', chat_type: chatType }, text },
  }
}
const g = { allowFrom: ['ann'], botId: 'bot1', accountName: 'dshbot', groupPrefix: '/ask' }

describe('gate / isAllowed / commandOf', () => {
  it('matches allowFrom by exact id', () => {
    expect(isAllowed(ann, [' ann '])).toBe(true)
    expect(isAllowed(bob, ['ann'])).toBe(false)
  })
  it('private: allowed handles, others are ignored', () => {
    expect(gate(upd('x'), g)).toBe('handle')
    expect(gate(upd('x', 'PRIVATE', bob), g)).toBe('ignore')
  })
  it('group: needs an allowed sender and a trigger, else log-only', () => {
    expect(gate(upd('hello', 'GROUP'), g)).toBe('log-only')
    expect(gate(upd('@dshbot hi', 'GROUP'), g)).toBe('handle')
    expect(gate(upd('/ask hi', 'GROUP'), g)).toBe('handle')
    expect(gate(upd('@dshbot hi', 'GROUP', bob), g)).toBe('log-only')
  })
  it('ignores bots and the bot itself', () => {
    expect(gate(upd('x', 'PRIVATE', { id: 'x', is_bot: true } as never), g)).toBe('ignore')
    expect(gate(upd('x', 'GROUP', { id: 'bot1' } as never), g)).toBe('ignore')
  })
  it('parses commands', () => {
    expect(commandOf('/reset')).toBe('reset')
    expect(commandOf(' /stop ')).toBe('stop')
    expect(commandOf('/help')).toBe('help')
    expect(commandOf('/reset now')).toBeUndefined()
  })
})

describe('handleMessage', () => {
  let dir: string
  let api: FakeZaloApi
  let deps: BotDeps
  let followups: Array<{ content: Array<{ type: string; text?: string }> }>
  let agents: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bot-'))
    api = new FakeZaloApi()
    followups = []
    const events: Array<{ type: string; data: unknown }> = []
    const agent = {
      id: 's1', status: 'idle',
      session: { get seq() { return events.length }, eventAt: (s: number) => events[s] },
      followup: (m: never) => {
        followups.push(m)
        events.push({ type: 'turn/start', data: {} })
        events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answer' }] } } })
        events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      },
      whenIdle: async () => {}, cancel: () => {},
    }
    agents = {
      resolve: vi.fn(async () => ({ agent, resumed: false })),
      reset: vi.fn(async () => {}), stop: vi.fn(() => false), markTurn: vi.fn(async () => {}),
      lastTurnAt: vi.fn(() => ''), workspaceFor: vi.fn(() => join(dir, 'ws')),
      setTurn: vi.fn(), memoryInjected: vi.fn(() => true), markMemoryInjected: vi.fn(async () => {}),
    }
    deps = {
      api,
      config: Config({ botToken: 't', allowFrom: ['ann'], workspaceRoot: join(dir, 'ws'), dataDir: dir, model: 'm', superAdmins: ['ann'], typingIntervalMs: 60_000 }),
      chatLog: new ChatLog(join(dir, 'log')),
      memory: new MemoryStore(join(dir, 'memory'), { maxEntries: 50, maxGlobalEntries: 50, maxEntryChars: 200 }),
      agents: agents as never,
      attachments: { saveImages: vi.fn(async (images: readonly unknown[]) => images.map((_, i) => ({ attachmentId: `att${i}` }))) },
      bot: { id: 'bot1', accountName: 'dshbot' },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('answers a private message and logs both sides', async () => {
    await handleMessage(upd('hi'), deps)
    expect(api.callsTo('sendMessage')[0]!.args.slice(0, 2)).toEqual(['p1', 'answer'])
    const log = await deps.chatLog.readAll('p1')
    expect(log.map(e => [e.text, e.handled ?? e.bot])).toEqual([['hi', true], ['answer', true]])
    expect(agents.markTurn).toHaveBeenCalledWith('p1', log[0]!.ts)
  })

  it('logs the id of an unknown private sender so it can be added to allowFrom', async () => {
    await handleMessage(upd('hi', 'PRIVATE', bob), deps)
    expect(api.callsTo('sendMessage')).toEqual([])
    expect(deps.log.info).toHaveBeenCalledWith('dsh-zalo: ignored a private message from bob (Bob), who is not in allowFrom')
  })

  it('logs an untriggered group message without a turn', async () => {
    await handleMessage(upd('chatter', 'GROUP'), deps)
    expect(api.callsTo('sendMessage')).toEqual([])
    expect((await deps.chatLog.readAll('g1')).map(e => e.text)).toEqual(['chatter'])
  })

  it('gives a triggered group turn the messages since the last turn', async () => {
    await handleMessage(upd('earlier', 'GROUP', bob), deps)
    await handleMessage(upd('@dshbot sum up', 'GROUP'), deps)
    const text = followups[0]!.content[0]!.text!
    expect(text).toMatch(/^<group_messages>\n- id:bob \(Bob\): earlier\n<\/group_messages>\n\nsum up$/)
  })

  it('runs commands for super admins only', async () => {
    await handleMessage(upd('/reset'), deps)
    expect(agents.reset).toHaveBeenCalledWith('p1')
    expect(api.callsTo('sendMessage')[0]!.args[1]).toBe('Started a new conversation.')
    deps = { ...deps, config: Config({ ...deps.config, superAdmins: [] }) }
    await handleMessage(upd('/reset'), deps)
    expect(agents.reset).toHaveBeenCalledTimes(1)
  })

  it('accepts a command addressed to the bot in a group', async () => {
    await handleMessage(upd('@dshbot /help', 'GROUP'), deps)
    expect(api.callsTo('sendMessage')[0]!.args[1]).toMatch(/^\/reset/)
  })
})

describe('createDispatcher', () => {
  it('serialises tasks per chat and reports busy chats', async () => {
    const order: string[] = []
    const dispatcher = createDispatcher({ log: { info: () => {}, warn: () => {}, error: () => {} } } as never)
    let release: (() => void) | undefined
    dispatcher.enqueue('c', () => new Promise<void>((r) => { release = () => { order.push('a'); r() } }))
    dispatcher.enqueue('c', async () => { order.push('b') })
    expect(dispatcher.isBusy('c')).toBe(true)
    await vi.waitFor(() => expect(release).toBeDefined())
    release!()
    await vi.waitFor(() => expect(dispatcher.isBusy('c')).toBe(false))
    expect(order).toEqual(['a', 'b'])
  })
})
