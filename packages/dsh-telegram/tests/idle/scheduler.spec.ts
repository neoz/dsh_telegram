import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDispatcher } from '../../src/bot.ts'
import { chatKey, ChatLog, type ChatLogEntry } from 'dsh-chat'
import { Config } from '../../src/idle/index.ts'
import { startIdle, type IdleDeps, type IdleEvent, type IdleHandle } from '../../src/idle/scheduler.ts'
import { FakeTelegramApi } from '../helpers/fake-api.ts'

const NOW = Date.parse('2026-10-04T05:00:00Z')
const MIN = 60_000
const CHAT = -5
const base = Config({ enabled: true, chatIds: [CHAT], idleMinutes: 10, minNewMessages: 5, chance: 1 })

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
let api: FakeTelegramApi
let chatLog: ChatLog
let tasks: Array<{ chatId: number; task: () => Promise<void> }>
let busy: Set<number>
let events: IdleEvent[]
let warns: string[]
let calls: GenerateOptions[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'idle-scheduler-'))
  api = new FakeTelegramApi()
  chatLog = new ChatLog(join(dir, 'log'))
  tasks = []
  busy = new Set()
  events = []
  warns = []
})
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }) })

function start(answer = '{"action":"reply","message_id":5,"text":"hehe"}', extra: Partial<IdleDeps> = {}): IdleHandle {
  const fake = fakeLlm(answer)
  calls = fake.calls
  return startIdle({
    config: base, provider: 'p', model: 'm', llm: fake.llm, api, chatLog,
    queue: { enqueue: (chatId, task) => { tasks.push({ chatId, task }) }, isBusy: chatId => busy.has(chatId) },
    botId: 1, botUsername: 'dshbot', log: { info: () => {}, warn: m => warns.push(m) },
    now: () => NOW, random: () => 0, record: e => events.push(e), ...extra,
  })
}
/** Writes a line to the chat log and feeds it to idle, as the core's telegram/message does. */
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
  it('engages when the lines arrive from inside the real dispatcher queue, as they do in production', async () => {
    // Every human line is written by a dispatcher task, so the chat's queue is busy while telegram/message fires.
    const dispatcher = createDispatcher({ log: { info: () => {}, warn: () => {}, error: () => {} } } as never)
    const idle = start(undefined, { queue: dispatcher })
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) dispatcher.enqueue(CHAT, () => say(idle, human(i + 1, m)))
    await vi.waitFor(() => expect(decisions()).toEqual([{ action: 'reply', messageId: '5', text: 'hehe' }]))
    idle.stop()
  })

  it('neither loses nor double-counts lines written while the window is seeded', async () => {
    for (const [i, m] of [4, 3, 2].entries()) await chatLog.append(chatKey('telegram', CHAT), human(i + 1, m))
    const snapshot = await chatLog.readAll(chatKey('telegram', CHAT))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slowLog = { readAll: async () => { await gate; return snapshot }, append: chatLog.append.bind(chatLog) }
    const idle = start(undefined, { chatLog: slowLog as never })
    // Line 3 is in the snapshot but its event arrives late; line 4 is written after the snapshot was taken.
    idle.observe(CHAT, human(3, 2))
    const late = human(4, 1)
    await chatLog.append(chatKey('telegram', CHAT), late)
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
    expect(tasks.map(t => t.chatId)).toEqual([CHAT])
    expect(vi.getTimerCount()).toBe(0)
    await runQueued()
    idle.stop()
    expect(api.callsTo('sendMessage')[0]!.args).toEqual([CHAT, 'hehe', { replyTo: { messageId: 5 } }])
    expect(checks()).toEqual(['go'])
    expect(decisions()).toEqual([{ action: 'reply', messageId: '5', text: 'hehe' }])
  })

  it('records the start once the windows are seeded, with the burst settings and without the persona', async () => {
    const idle = start()
    expect(events).toEqual([])
    await idle.ready
    idle.stop()
    expect(events[0]).toMatchObject({ event: 'start', chatIds: [CHAT], config: { hotWindowMinutes: 5, burstGapMinutes: 15, maxPerBurst: 1 } })
    expect(events[0]).not.toHaveProperty('config.persona')
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
    for (const [i, m] of [4, 3, 2, 1].entries()) await chatLog.append(chatKey('telegram', CHAT), human(i + 1, m))
    const idle = start()
    await idle.ready
    await say(idle, human(5, 0.5))
    idle.stop()
    expect(tasks).toHaveLength(1)
  })

  it('records a model error and a failed Telegram call', async () => {
    const broken = { async *stream(): AsyncIterable<StreamChunk> { throw new Error('model down') } }
    const failing = start('', { llm: broken })
    await failing.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(failing, human(i + 1, m))
    await runQueued()
    failing.stop()
    api.failNext('setReaction', new Error('REACTION_INVALID'))
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
    expect(decisions()).toEqual([{ action: 'reply', messageId: '5', text: 'hehe' }])
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
    const OTHER = -6
    await mkdir(join(dir, 'log', 'telegram', 'chatlog'), { recursive: true })
    await writeFile(join(dir, 'log', 'telegram', 'chatlog', `${OTHER}.jsonl`), '{not json\n', 'utf8')
    const idle = start(undefined, { config: { ...base, chatIds: [OTHER, CHAT] } })
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, human(i + 1, m))
    idle.stop()
    expect(warns.some(m => m.includes(`chat ${OTHER}`))).toBe(true)
    expect(tasks.map(t => t.chatId)).toEqual([CHAT])
  })

  it('ignores chats outside the allowlist, a disabled config, and tasks after stop', async () => {
    const idle = start()
    await idle.ready
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, human(i + 1, m), -99)
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
