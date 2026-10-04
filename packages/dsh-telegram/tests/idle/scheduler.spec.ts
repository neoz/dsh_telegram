import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatLog, type ChatLogEntry } from '../../src/chatlog.ts'
import { Config } from '../../src/idle/index.ts'
import { startIdle, type IdleDeps, type IdleEvent, type IdleHandle } from '../../src/idle/scheduler.ts'
import { FakeTelegramApi } from '../helpers/fake-api.ts'

const NOW = Date.parse('2026-10-04T05:00:00Z')
const MIN = 60_000
const CHAT = -5
const base = Config({ enabled: true, chatIds: [CHAT], idleMinutes: 10, minNewMessages: 5, chance: 1 })

function human(id: number, minutesAgo: number, user = id % 2 === 0 ? 8 : 7): ChatLogEntry {
  return { ts: new Date(NOW - minutesAgo * MIN).toISOString(), message_id: id, user_id: user, username: `u${user}`, name: `U${user}`, text: `m${id}` }
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
  await chatLog.append(chatId, entry)
  idle.observe(chatId, entry)
}
async function runQueued(): Promise<void> {
  while (tasks.length > 0) await tasks.shift()!.task()
}
const checks = () => events.filter(e => e.event === 'check').map(e => (e as { verdict: string }).verdict)
const decisions = () => events.filter(e => e.event === 'decision').map(({ ts: _ts, chatId: _chat, event: _event, ...rest }) => rest)

describe('startIdle', () => {
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
    expect(decisions()).toEqual([{ action: 'reply', messageId: 5, text: 'hehe' }])
  })

  it('records the start with the burst settings and without the persona', async () => {
    const idle = start()
    idle.stop()
    expect(events[0]).toMatchObject({ event: 'start', chatIds: [CHAT], config: { hotWindowMinutes: 5, burstGapMinutes: 15, maxPerBurst: 1 } })
    expect(events[0]).not.toHaveProperty('config.persona')
  })

  it('records a busy chat and enqueues nothing', async () => {
    const idle = start()
    await idle.ready
    busy.add(CHAT)
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) await say(idle, human(i + 1, m))
    idle.stop()
    expect(tasks).toHaveLength(0)
    expect(checks()).toEqual(['busy'])
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
    for (const [i, m] of [4, 3, 2, 1].entries()) await chatLog.append(CHAT, human(i + 1, m))
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
      { action: 'react', messageId: 5, emoji: '\u{1F525}', error: 'REACTION_INVALID' },
    ])
  })

  it('a corrupted chat log in one chat leaves the others working', async () => {
    const OTHER = -6
    await mkdir(join(dir, 'log'), { recursive: true })
    await writeFile(join(dir, 'log', `${OTHER}.jsonl`), '{not json\n', 'utf8')
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
