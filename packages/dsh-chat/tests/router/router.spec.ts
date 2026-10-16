import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatLog } from '../../src/log/chatlog.ts'
import { MemoryStore } from '../../src/memory/store.ts'
import type { InboundMessage } from '../../src/router/channel.ts'
import { ChatRouter, commandOf, HELP_TEXT, type RouterConfig } from '../../src/router/router.ts'
import type { ChatSender } from '../../src/sessions/agents.ts'
import { FakeChannel } from './fake-channel.ts'

const ann: ChatSender = { id: '7', name: 'Ann', username: 'Ann' }
const bob: ChatSender = { id: '9', name: 'Bob' }
const turnStart = { type: 'turn/start', data: { turn: 1 } }
const turnEnd = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }

let dir: string
let chatLog: ChatLog
let memory: MemoryStore
let telegram: FakeChannel
let zalo: FakeChannel
let followups: { key: string; text: string; images: number }[]
let agents: Record<string, ReturnType<typeof vi.fn>>
let turnsNoted: string[]
let warnings: string[]
let infos: string[]
/** Each turn replies `ok`; `hold` keeps the next turn running until released. */
let hold: Promise<void> | undefined

function fakeAgentFor(key: string) {
  const events: unknown[] = []
  let running = Promise.resolve()
  return {
    id: `agent-${key}`,
    session: { get seq() { return events.length }, eventAt: (seq: number) => events[seq] as never },
    followup: (message: { content: { type: string; text?: string }[] }) => {
      followups.push({ key, text: message.content[0]!.text!, images: message.content.length - 1 })
      const wait = hold
      running = (wait ?? Promise.resolve()).then(() => {
        events.push(turnStart, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } }, turnEnd)
      })
    },
    whenIdle: () => running,
    cancel: () => {},
  }
}

function router(config: Partial<RouterConfig> = {}): ChatRouter {
  const r = new ChatRouter({
    config: { allowFrom: ['telegram:@ann', 'zalo:7'], superAdmins: ['telegram:7'], recentMessagesLimit: 30, turnTimeoutMs: 10_000, ...config },
    chatLog,
    memory,
    agents: agents as never,
    attachments: { saveImages: vi.fn(async (images: unknown[]) => images.map((_, i) => ({ attachmentId: `att${i}` }))) },
    feed: () => () => {},
    emitTurn: key => turnsNoted.push(key),
    log: { info: msg => infos.push(msg), warn: msg => warnings.push(msg), error: msg => warnings.push(msg) },
  })
  r.register(telegram)
  r.register(zalo)
  return r
}

function message(extra: Partial<InboundMessage> & { chatKey: string }, loadText = 'hello'): InboundMessage {
  const id = extra.messageId ?? '10'
  const sender = extra.sender ?? ann
  return {
    messageId: id, sender, isGroup: false, addressed: true, text: loadText, at: Date.now(),
    load: async mode => ({
      logEntry: { ts: new Date().toISOString(), message_id: id, user_id: sender.id, name: sender.name, text: loadText },
      text: mode === 'turn' ? loadText : '',
      images: [],
    }),
    ...extra,
  }
}

const idle = (r: ChatRouter, key: string) => vi.waitFor(() => expect(r.isBusy(key)).toBe(false))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-'))
  chatLog = new ChatLog(join(dir, 'data'))
  memory = new MemoryStore(join(dir, 'data'), { maxEntries: 50, maxGlobalEntries: 50, maxEntryChars: 200 })
  telegram = new FakeChannel('telegram')
  zalo = new FakeChannel('zalo')
  followups = []
  turnsNoted = []
  warnings = []
  infos = []
  hold = undefined
  const turns = new Map<string, unknown>()
  const lastTurn = new Map<string, string>()
  const injected = new Set<string>()
  agents = {
    resolve: vi.fn(async (key: string) => ({ agent: fakeAgentFor(key), resumed: false })),
    reset: vi.fn(async () => {}),
    stop: vi.fn(() => false),
    setTurn: vi.fn((key: string, turn: unknown) => { turns.set(key, turn) }),
    turnOf: vi.fn((key: string) => turns.get(key)),
    chatOf: vi.fn(() => undefined),
    lastTurnMessageId: vi.fn((key: string) => lastTurn.get(key) ?? ''),
    markTurn: vi.fn(async (key: string, id: string) => { lastTurn.set(key, id) }),
    memoryInjected: vi.fn((key: string, session: string) => injected.has(`${key}/${session}`)),
    markMemoryInjected: vi.fn(async (key: string, session: string) => { injected.add(`${key}/${session}`) }),
  }
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('commandOf', () => {
  it('reads bare commands only', () => {
    expect(commandOf('/reset')).toBe('reset')
    expect(commandOf('  /stop ')).toBe('stop')
    expect(commandOf('/help')).toBe('help')
    expect(commandOf('/stop@other')).toBeUndefined()
    expect(commandOf('reset please')).toBeUndefined()
  })
})

describe('ChatRouter', () => {
  it('runs a DM turn: logs both sides, opens the turn on the message and records the turn context', async () => {
    const r = router()
    r.inbound(message({ chatKey: 'telegram:5' }))
    await idle(r, 'telegram:5')
    expect(telegram.turns).toMatchObject([{ chatId: '5', replyTo: '10', reports: [{ kind: 'reply', text: 'ok' }], closed: true }])
    expect(agents.setTurn).toHaveBeenCalledWith('telegram:5', { sender: ann, isGroup: false, isSuperAdmin: true })
    expect(agents.markTurn).toHaveBeenCalledWith('telegram:5', '10')
    const log = await chatLog.readAll('telegram:5')
    expect(log.map(e => [e.message_id, e.text, e.handled, e.bot, e.reply_to, e.name])).toEqual([
      ['10', 'hello', true, undefined, undefined, 'Ann'],
      ['r1', 'ok', undefined, true, '10', 'telegrambot'],
    ])
    expect(turnsNoted).toEqual(['telegram:5', 'telegram:5'])
  })

  it('allows a Telegram username case-insensitively and a super admin not in allowFrom', async () => {
    const r = router({ allowFrom: ['telegram:@ann'], superAdmins: ['zalo:9'] })
    r.inbound(message({ chatKey: 'telegram:5' }))
    r.inbound(message({ chatKey: 'zalo:6', sender: bob }))
    await idle(r, 'telegram:5')
    await idle(r, 'zalo:6')
    expect(telegram.turns).toHaveLength(1)
    expect(zalo.turns).toHaveLength(1)
  })

  it('ignores a DM stranger without logging the chat, and names the stranger once', async () => {
    const r = router()
    r.inbound(message({ chatKey: 'telegram:9', sender: bob }))
    r.inbound(message({ chatKey: 'telegram:9', sender: bob }))
    await idle(r, 'telegram:9')
    expect(await chatLog.readAll('telegram:9')).toEqual([])
    expect(infos.filter(m => m.includes('telegram:9'))).toHaveLength(1)
  })

  it('logs an unaddressed group message, and an addressed one from a stranger, without a turn', async () => {
    const r = router()
    r.inbound(message({ chatKey: 'telegram:-5', isGroup: true, addressed: false }))
    r.inbound(message({ chatKey: 'telegram:-5', isGroup: true, sender: bob, messageId: '11' }))
    await idle(r, 'telegram:-5')
    expect(telegram.turns).toEqual([])
    expect((await chatLog.readAll('telegram:-5')).map(e => [e.message_id, e.handled])).toEqual([['10', undefined], ['11', undefined]])
    expect(turnsNoted).toEqual([])
  })

  it('gives a group turn the messages since the last turn, after the memory block', async () => {
    await memory.save({ kind: 'chat', key: 'telegram:-5' }, 'likes tea')
    const r = router()
    r.inbound(message({ chatKey: 'telegram:-5', isGroup: true, addressed: false, sender: bob, messageId: '1' }, 'first\nline'))
    r.inbound(message({ chatKey: 'telegram:-5', isGroup: true, messageId: '2' }, 'ask'))
    await idle(r, 'telegram:-5')
    const text = followups[0]!.text
    expect(text.indexOf('<memory>')).toBe(0)
    expect(text).toContain('<group_messages>\n- id:9 (Bob): first line\n</group_messages>\n\nask')
  })

  it('runs commands for super admins only; /help and /stop bypass the queue', async () => {
    const r = router()
    let release!: () => void
    hold = new Promise<void>((resolve) => { release = resolve })
    r.inbound(message({ chatKey: 'telegram:5' }))
    await vi.waitFor(() => expect(followups).toHaveLength(1))
    r.inbound(message({ chatKey: 'telegram:5', messageId: '11' }, '/help'))
    r.inbound(message({ chatKey: 'telegram:5', messageId: '12' }, '/stop'))
    await vi.waitFor(() => expect(telegram.sent.map(s => s.text)).toEqual([HELP_TEXT, 'Nothing is running.']))
    hold = undefined
    release()
    await idle(r, 'telegram:5')
    r.inbound(message({ chatKey: 'zalo:7', sender: { id: '7', name: 'Z' } }, '/stop'))
    await idle(r, 'zalo:7')
    expect(zalo.turns).toHaveLength(1)
    expect(agents.stop).toHaveBeenCalledTimes(1)
  })

  it('/reset stops the running turn at once and resets after queued work', async () => {
    const r = router()
    let release!: () => void
    hold = new Promise<void>((resolve) => { release = resolve })
    r.inbound(message({ chatKey: 'telegram:5' }))
    await vi.waitFor(() => expect(followups).toHaveLength(1))
    r.inbound(message({ chatKey: 'telegram:5', messageId: '11' }, '/reset'))
    expect(agents.stop).toHaveBeenCalledWith('telegram:5')
    expect(agents.reset).not.toHaveBeenCalled()
    hold = undefined
    release()
    await idle(r, 'telegram:5')
    expect(agents.reset).toHaveBeenCalledWith('telegram:5')
    expect(telegram.sent.map(s => s.text)).toEqual(['Started a new conversation.'])
  })

  it('tells the chat when a resume failed', async () => {
    agents.resolve!.mockImplementationOnce(async (key: string) => ({ agent: fakeAgentFor(key), resumed: false, resumeFailed: 'gone' }))
    const r = router()
    r.inbound(message({ chatKey: 'zalo:7', sender: { id: '7', name: 'Z' } }))
    await idle(r, 'zalo:7')
    expect(zalo.sent[0]!.text).toBe('The previous conversation could not be restored; starting a new one.')
  })

  it('prompt runs a turn with nothing to quote or mark, behind queued work', async () => {
    const r = router()
    r.prompt('telegram:-5', { text: 'remind me', sender: ann, isGroup: true })
    await idle(r, 'telegram:-5')
    expect(followups[0]!.text.endsWith('remind me')).toBe(true)
    expect(followups[0]!.text).not.toContain('<group_messages>')
    expect(telegram.turns[0]!.replyTo).toBeUndefined()
    expect(agents.markTurn).not.toHaveBeenCalled()
    expect(agents.setTurn).toHaveBeenCalledWith('telegram:-5', { sender: ann, isGroup: true, isSuperAdmin: true })
    expect(turnsNoted).toEqual(['telegram:-5'])
  })

  it('keeps two channels with the same chat id apart', async () => {
    const r = router()
    r.inbound(message({ chatKey: 'telegram:5' }, 'from telegram'))
    r.inbound(message({ chatKey: 'zalo:5', sender: { id: '7', name: 'Z' } }, 'from zalo'))
    await idle(r, 'telegram:5')
    await idle(r, 'zalo:5')
    expect(followups.map(f => f.key).sort()).toEqual(['telegram:5', 'zalo:5'])
    expect(telegram.turns.map(t => t.chatId)).toEqual(['5'])
    expect(zalo.turns.map(t => t.chatId)).toEqual(['5'])
    expect((await chatLog.readAll('telegram:5')).map(e => e.text)).toEqual(['from telegram', 'ok'])
    expect((await chatLog.readAll('zalo:5')).map(e => e.text)).toEqual(['from zalo', 'ok'])
  })

  it('skips queued work of an unregistered channel', async () => {
    const r = router()
    const unregister = r.register(new FakeChannel('other'))
    const ran: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    r.enqueue('other:1', () => held)
    r.enqueue('other:1', async () => { ran.push('x') })
    await vi.waitFor(() => expect(r.isBusy('other:1')).toBe(true))
    unregister()
    release()
    await idle(r, 'other:1')
    expect(ran).toEqual([])
    expect(warnings.some(w => w.includes('other:1') && w.includes('channel offline'))).toBe(true)
  })

  it('a failed delivery closes the sink and the next turn still runs', async () => {
    const r = router()
    telegram.failDeliver = true
    r.inbound(message({ chatKey: 'telegram:5' }))
    r.inbound(message({ chatKey: 'telegram:5', messageId: '11' }))
    await idle(r, 'telegram:5')
    expect(telegram.turns.map(t => t.closed)).toEqual([true, true])
    expect(telegram.turns[1]!.reports).toHaveLength(1)
  })

  it('refuses a second channel with the same id', () => {
    const r = router()
    expect(() => r.register(new FakeChannel('zalo'))).toThrow('already registered')
  })
})
