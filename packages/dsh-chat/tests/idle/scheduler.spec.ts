import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../../src/idle/index.ts'
import { startIdle, type IdleDeps, type IdleEvent, type IdleHandle } from '../../src/idle/scheduler.ts'
import { chatKey } from '../../src/keys.ts'
import { ChatLog, type ChatLogEntry } from '../../src/log/chatlog.ts'
import { ChatQueue } from '../../src/router/queue.ts'
import { FakeChannel } from '../router/fake-channel.ts'

const NOW = Date.parse('2026-10-04T05:00:00Z')
const MIN = 60_000
const CHAT = '-5'
const KEY = chatKey('telegram', CHAT)
const base = Config({ enabled: true, chatKeys: [KEY], idleMinutes: 10, minNewMessages: 5, chance: 1 })

function human(id: number, minutesAgo: number, user = id % 2 === 0 ? 8 : 7): ChatLogEntry {
  return { ts: new Date(NOW - minutesAgo * MIN).toISOString(), message_id: String(id), user_id: String(user), username: `u${user}`, name: `U${user}`, text: `m${id}` }
}
function fakeLlm(answer: string) {
  const calls: GenerateOptions[] = []
  const llm = {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'finish', reason: { kind: 'stop' } } as never
    },
  }
  return { llm, calls }
}

let dir: string
let telegram: FakeChannel
let online: boolean
let chatLog: ChatLog
let tasks: Array<{ key: string; task: () => Promise<void> }>
let events: IdleEvent[]
let warns: string[]
let calls: GenerateOptions[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'idle-scheduler-'))
  telegram = new FakeChannel('telegram')
  online = true
  chatLog = new ChatLog(join(dir, 'log'))
  tasks = []
  events = []
  warns = []
})
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }) })

function start(answer = '{"action":"reply","message_id":5,"text":"hehe"}', extra: Partial<IdleDeps> = {}): IdleHandle {
  const fake = fakeLlm(answer)
  calls = fake.calls
  return startIdle({
    config: base, channel: 'telegram', chatIds: [CHAT], provider: 'p', model: 'm', llm: fake.llm, chatLog,
    chat: { channel: id => (id === 'telegram' && online ? telegram : undefined), enqueue: (key, task) => { tasks.push({ key, task }) } },
    log: { info: () => {}, warn: m => warns.push(m) },
    now: () => NOW, random: () => 0, record: e => events.push(e), ...extra,
  })
}
/** Writes a line to the chat log and feeds it to idle, as the plugin's chat/message listener does. */
async function say(idle: IdleHandle, entry: ChatLogEntry, chatId = CHAT): Promise<void> {
  await chatLog.append(chatKey('telegram', chatId), entry)
  idle.observe(chatId, entry)
}
async function runQueued(): Promise<void> {
  while (tasks.length > 0) await tasks.shift()!.task()
}
const checks = () => events.filter(e => e.event === 'check').map(e => (e as { verdict: string }).verdict)
const decisions = () => events.filter(e => e.event === 'decision').map(({ ts: _ts, chatId: _chat, event: _event, ...rest }) => rest)

describe('startIdle', () => {
  it('engages when the lines arrive from inside the real chat queue, as they do in production', async () => {
    // Every human line is written by a queued task, so the chat's queue is busy while chat/message fires.
    const chatQueue = new ChatQueue(() => {})
    const chat = { channel: () => telegram, enqueue: (key: string, task: () => Promise<void>) => chatQueue.enqueue(key, task) }
    const idle = start(undefined, { chat })
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) chat.enqueue(KEY, () => say(idle, human(i + 1, m)))
    await vi.waitFor(() => expect(decisions()).toEqual([{ action: 'reply', messageId: '5', as: 'native', text: 'hehe' }]))
    idle.stop()
  })

  it('neither loses nor double-counts lines written while the window is seeded', async () => {
    for (const [i, m] of [4, 3, 2].entries()) await chatLog.append(KEY, human(i + 1, m))
    const snapshot = await chatLog.readAll(KEY)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slowLog = { readAll: async () => { await gate; return snapshot }, append: chatLog.append.bind(chatLog) }
    const idle = start(undefined, { chatLog: slowLog as never })
    // Line 3 is in the snapshot but its event arrives late; line 4 is written after the snapshot was taken.
    idle.observe(CHAT, human(3, 2))
    const late = human(4, 1)
    await chatLog.append(KEY, late)
    idle.observe(CHAT, late)
    release()
    await idle.ready
    await say(idle, human(5, 0.5))
    idle.stop()
    expect(tasks).toHaveLength(1)
    expect(events.find(e => e.event === 'check')).toMatchObject({ verdict: 'go', fresh: 5 })
  })

  it('a bot line never triggers a check', async () => {
    const idle = start()
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1].entries()) await say(idle, human(i + 1, m))
    await say(idle, { ...human(9, 0.5), user_id: '1', bot: true })
    idle.stop()
    expect(checks()).toEqual([])
  })

  it('enqueues as soon as a burst gets hot, with no timer, and replies', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout'] })
    const idle = start()
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1].entries()) await say(idle, human(i + 1, m))
    expect(tasks).toHaveLength(0)
    await say(idle, human(5, 0.5))
    expect(tasks.map(t => t.key)).toEqual([KEY])
    expect(vi.getTimerCount()).toBe(0)
    await runQueued()
    idle.stop()
    expect(telegram.sent).toEqual([{ chatId: CHAT, text: 'hehe', replyTo: '5' }])
    expect((await chatLog.readAll(KEY)).at(-1)).toMatchObject({ message_id: 's1', text: 'hehe', reply_to: '5', bot: true, user_id: 'telegram-bot', name: 'telegrambot' })
    expect(checks()).toEqual(['go'])
    expect(decisions()).toEqual([{ action: 'reply', messageId: '5', as: 'native', text: 'hehe' }])
  })

  it('reacts through the channel, and logs nothing when the reaction posted no message', async () => {
    const idle = start('{"action":"react","message_id":5,"emoji":"\u{1F44D}"}')
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, human(i + 1, m))
    await runQueued()
    idle.stop()
    expect(telegram.reactions).toEqual([{ chatId: CHAT, messageId: '5', emoji: '\u{1F44D}' }])
    expect((await chatLog.readAll(KEY)).filter(e => e.bot === true)).toEqual([])
    expect(decisions()).toEqual([{ action: 'react', messageId: '5', as: 'native', emoji: '\u{1F44D}' }])
  })

  it('logs a reaction that posted a message, so the next decision sees the bot answered', async () => {
    telegram.react = async (chatId, messageId, emoji) => {
      telegram.reactions.push({ chatId, messageId, emoji })
      return { as: 'fallback', messageId: 'st1', text: '[sticker \u{1F44D}]' }
    }
    const idle = start('{"action":"react","message_id":5,"emoji":"\u{1F44D}"}')
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, human(i + 1, m))
    await runQueued()
    idle.stop()
    const last = (await chatLog.readAll(KEY)).at(-1)!
    expect(last).toMatchObject({ message_id: 'st1', text: '[sticker \u{1F44D}]', reply_to: '5', bot: true, user_id: 'telegram-bot', name: 'telegrambot' })
    expect(decisions().at(-1)).toMatchObject({ action: 'react', as: 'fallback' })
  })

  it('records an error decision when the channel is offline at engagement time', async () => {
    const idle = start()
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, human(i + 1, m))
    online = false
    await runQueued()
    idle.stop()
    expect(decisions().at(-1)).toMatchObject({ action: 'reply', error: expect.stringContaining('offline') })
    expect(telegram.sent).toEqual([])
  })

  it('does not spend the daily cap on an engagement the offline channel never carried', async () => {
    let t = NOW
    const idle = start(undefined, { config: { ...base, maxPerDay: 1, maxPerBurst: 2, slotGapMinutes: 1 }, now: () => t })
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, human(i + 1, m))
    online = false
    await runQueued()
    online = true
    t = NOW + 2 * MIN
    for (const [i, m] of [-1.1, -1.3, -1.5, -1.7, -1.9].entries()) await say(idle, human(i + 6, m))
    await runQueued()
    idle.stop()
    expect(checks().filter(verdict => verdict === 'go')).toHaveLength(2)
    expect(checks()).not.toContain('daily_cap')
    expect(telegram.sent).toHaveLength(1)
  })

  it('records the start once the windows are seeded, with the burst settings and without the persona', async () => {
    const idle = start()
    expect(events).toEqual([])
    await idle.ready
    idle.stop()
    expect(events[0]).toMatchObject({ event: 'start', chatIds: [CHAT], config: { hotWindowMinutes: 5, burstGapMinutes: 15, maxPerBurst: 1 } })
    expect(events[0]).not.toHaveProperty('config.persona')
    expect(events[0]).not.toHaveProperty('config.chatKeys')
  })

  it('does not repeat a check while the verdict stays the same', async () => {
    const idle = start()
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5, 0.4, 0.3, 0.2].entries()) await say(idle, human(i + 1, m))
    idle.stop()
    expect(tasks).toHaveLength(1)
    expect(checks()).toEqual(['go', 'burst_spent'])
  })

  it('cancels the queued task when the bot was addressed meanwhile', async () => {
    const idle = start()
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, human(i + 1, m))
    idle.noteTurn(CHAT)
    await runQueued()
    idle.stop()
    expect(calls).toHaveLength(0)
    expect(decisions()).toEqual([{ action: 'cancelled' }])
  })

  it('seeds the window before evaluating', async () => {
    for (const [i, m] of [4, 3, 2, 1].entries()) await chatLog.append(KEY, human(i + 1, m))
    const idle = start()
    await idle.ready
    await say(idle, human(5, 0.5))
    idle.stop()
    expect(tasks).toHaveLength(1)
  })

  it('records a model error and a failed channel call', async () => {
    const broken = { async *stream(): AsyncIterable<StreamChunk> { throw new Error('model down') } }
    const failing = start('', { llm: broken })
    await failing.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(failing, human(i + 1, m))
    await runQueued()
    failing.stop()
    telegram.react = async () => { throw new Error('REACTION_INVALID') }
    const rejected = start('{"action":"react","message_id":5,"emoji":"\u{1F525}"}')
    await rejected.ready
    await say(rejected, human(6, 0.4))
    await runQueued()
    rejected.stop()
    expect(decisions()).toEqual([
      { action: 'error', error: 'model down' },
      { action: 'react', messageId: '5', emoji: '\u{1F525}', error: 'REACTION_INVALID' },
    ])
  })

  it('shows the model the newest three photos in the context, skipping files that are gone', async () => {
    const photo = async (id: number, minutesAgo: number, file: string | undefined): Promise<ChatLogEntry> => {
      const path = join(dir, `${id}.jpg`)
      if (file !== undefined) await writeFile(path, file)
      return { ...human(id, minutesAgo), text: '[photo]', media: [path] }
    }
    const saved: string[][] = []
    const saveImages = async (images: ReadonlyArray<{ data: Uint8Array }>) => {
      saved.push(images.map(i => Buffer.from(i.data).toString()))
      return images.map((_, i) => ({ attachmentId: `ref${saved.length}-${i}` }))
    }
    const idle = start(undefined, { saveImages })
    await idle.ready
    await say(idle, await photo(1, 4, 'one'))
    await say(idle, await photo(2, 3, undefined))
    await say(idle, await photo(3, 2, 'three'))
    await say(idle, await photo(4, 1, 'four'))
    await say(idle, { ...human(5, 0.5), media: [join(dir, 'notes.pdf')] })
    await runQueued()
    idle.stop()
    // Photo 1 is fourth from the end, and photo 2's file was swept, so only 3 and 4 are read.
    expect(saved).toEqual([['three', 'four']])
    expect(calls[0]!.messages[0]!.content.slice(1)).toEqual([
      { type: 'text', text: '[photo of message 3]' },
      { type: 'image', attachment: { attachmentId: 'ref1-0' } },
      { type: 'text', text: '[photo of message 4]' },
      { type: 'image', attachment: { attachmentId: 'ref1-1' } },
    ])
    expect(decisions()).toEqual([{ action: 'reply', messageId: '5', as: 'native', text: 'hehe' }])
  })

  it('admits a png context photo with its own media type', async () => {
    const photo = join(dir, 'p.png')
    await writeFile(photo, Buffer.from([0x89, 0x50]))
    const saveImages = vi.fn(async (images: ReadonlyArray<unknown>) => images.map(() => ({ attachmentId: 'a' })))
    const idle = start(undefined, { saveImages })
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, { ...human(i + 1, m), ...(i === 4 ? { media: [photo] } : {}) })
    await runQueued()
    idle.stop()
    expect(saveImages.mock.calls[0]![0]).toEqual([{ data: Buffer.from([0x89, 0x50]), mediaType: 'image/png' }])
  })

  it('decides from text alone when the call with photos fails', async () => {
    const path = join(dir, 'p.jpg')
    await writeFile(path, 'jpeg')
    const picky = {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (options.messages[0]!.content.some(b => b.type === 'image')) throw new Error('model takes text only')
        yield { type: 'text-delta', index: 0, text: '{"action":"skip"}' }
        yield { type: 'finish', reason: { kind: 'stop' } } as never
      },
    }
    const idle = start('', { llm: picky, saveImages: async images => images.map(() => ({ attachmentId: 'ref' })) })
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1].entries()) await say(idle, human(i + 1, m))
    await say(idle, { ...human(5, 0.5), text: '[photo]', media: [path] })
    await runQueued()
    idle.stop()
    expect(warns.some(m => m.includes('with photos failed') && m.includes('model takes text only'))).toBe(true)
    expect(decisions()).toEqual([{ action: 'skip' }])
  })

  it('a corrupted chat log in one chat leaves the others working', async () => {
    const OTHER = '-6'
    await mkdir(join(dir, 'log', 'telegram', 'chatlog'), { recursive: true })
    await writeFile(join(dir, 'log', 'telegram', 'chatlog', `${OTHER}.jsonl`), '{not json\n', 'utf8')
    const idle = start(undefined, { chatIds: [OTHER, CHAT] })
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, human(i + 1, m))
    idle.stop()
    expect(warns.some(m => m.includes(`telegram:${OTHER}`))).toBe(true)
    expect(tasks.map(t => t.key)).toEqual([KEY])
  })

  it('ignores chats outside the allowlist, a disabled config, and tasks after stop', async () => {
    const idle = start()
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, human(i + 1, m), '-99')
    expect(tasks).toHaveLength(0)
    const off = start(undefined, { config: { ...base, enabled: false } })
    await off.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(off, human(i + 1, m))
    expect(tasks).toHaveLength(0)
    for (const [i, m] of [0.4, 0.3, 0.2, 0.1, 0.05].entries()) await say(idle, human(i + 10, m))
    idle.stop()
    await runQueued()
    expect(calls).toHaveLength(0)
  })
})
