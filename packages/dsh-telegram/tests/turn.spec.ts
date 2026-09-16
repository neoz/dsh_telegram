import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { UNDELIVERED_NOTICE, UTF8_BOM } from '../src/render.ts'
import { TelegramApiError } from '../src/telegram-api.ts'
import { runTurn, type SessionEventFeed, type TurnAgent, type TurnOptions } from '../src/turn.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

type AnyEvent = { type: string; data: unknown }

/** Fake agent: `script` runs when followup is called and may emit events. */
function fakeAgent(script: (emit: (event: AnyEvent) => void) => Promise<void> | void) {
  const events: AnyEvent[] = []
  const listeners = new Set<(sessionId: string, event: AnyEvent) => void>()
  let running: Promise<void> = Promise.resolve()
  const emit = (event: AnyEvent) => {
    events.push(event)
    for (const l of listeners) l('s1', event)
  }
  const agent: TurnAgent = {
    id: 's1',
    session: { get seq() { return events.length }, eventAt: (seq: number) => events[seq] as never, header: { cwd: '/w' } },
    followup: () => { running = Promise.resolve().then(() => script(emit)) },
    whenIdle: () => running,
    cancel: () => { emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'cancelled' } } }) },
  }
  const feed: SessionEventFeed = listener => {
    listeners.add(listener as never)
    return () => listeners.delete(listener as never)
  }
  return { agent, feed, events }
}

const reply = (text: string): AnyEvent => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } } })
const toolCall = (name: string, args: object): AnyEvent => ({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c', name, arguments: JSON.stringify(args) } })
const turnStart: AnyEvent = { type: 'turn/start', data: { turn: 1 } }
const turnEnd = (reason: object): AnyEvent => ({ type: 'turn/end', data: { turn: 1, reason } })
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

let dir: string
let api: FakeTelegramApi
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'turn-')); api = new FakeTelegramApi() })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const status = Config({ botToken: 't', allowFrom: ['1'], workspaceRoot: '/w', dataDir: '/d', model: 'm' }).status

function options(agentParts: ReturnType<typeof fakeAgent>, extra: Partial<TurnOptions> = {}): TurnOptions {
  return {
    api, agent: agentParts.agent, feed: agentParts.feed, chatId: 5, replyToMessageId: 10,
    content: [{ type: 'text', text: 'hi' }], outboxDir: join(dir, 'outbox'),
    messageSize: 1024, statusEditIntervalMs: 0, turnTimeoutMs: 10_000, status,
    log: { warn: () => {}, error: () => {} }, ...extra,
  }
}

describe('runTurn', () => {
  it('sends a reply placeholder, then edits it into the rendered answer', async () => {
    const a = fakeAgent(emit => { emit(turnStart); emit(reply('**done**')); emit(turnEnd({ kind: 'completed' })) })
    const result = await runTurn(options(a))
    expect(result.outcome).toBe('edited')
    expect(api.callsTo('sendChatAction')).toHaveLength(1)
    const [chatId, text, opts] = api.callsTo('sendMessage')[0]!.args as [number, string, { replyTo?: { messageId: number } }]
    expect([chatId, text, opts.replyTo]).toEqual([5, 'Thinking...', { messageId: 10 }])
    const edit = api.callsTo('editMessageText').at(-1)!.args
    expect(edit).toEqual([5, 100, '<b>done</b>', { parseMode: 'HTML' }])
    expect(result.sentMessageId).toBe(100)
    expect(result.timing.agentMs).toBeGreaterThanOrEqual(0)
    expect(result.timing.deliverMs).toBeGreaterThanOrEqual(0)
  })

  it('edits the placeholder with group labels, never tool arguments, and skips repeats', async () => {
    const a = fakeAgent(async emit => {
      emit(turnStart)
      emit(toolCall('bash', { command: 'rm -rf /tmp/x' }))
      await tick()
      emit(toolCall('bash', { command: 'ls' }))
      await tick()
      emit(toolCall('read', { path: '/w/a.txt' }))
      await tick()
      emit(reply('ok'))
      emit(turnEnd({ kind: 'completed' }))
    })
    await runTurn(options(a))
    const statuses = api.callsTo('editMessageText').map(c => c.args[2])
    expect(statuses).toEqual(['Running a command...', 'Reading files...', 'ok'])
  })

  it('sends fresh when the placeholder edit fails', async () => {
    const a = fakeAgent(emit => { emit(turnStart); emit(reply('answer')); emit(turnEnd({ kind: 'completed' })) })
    api.failNext('editMessageText', new TelegramApiError('message to edit not found', 400))
    const result = await runTurn(options(a))
    expect(result.outcome).toBe('sent')
    expect(api.callsTo('deleteMessage')[0]?.args).toEqual([5, 100])
    expect(api.callsTo('sendMessage').at(-1)!.args[1]).toBe('answer')
  })

  it('retries a rejected send without the collapse wrapper, then as plain text', async () => {
    const long = 'word '.repeat(400)
    // Failures are queued from inside the turn so the placeholder send itself succeeds.
    const a = fakeAgent((emit) => {
      api.failNext('editMessageText', new TelegramApiError("can't parse entities", 400))
      api.failNext('sendMessage', new TelegramApiError("can't parse entities", 400))
      api.failNext('sendMessage', new TelegramApiError("can't parse entities", 400))
      emit(turnStart); emit(reply(long)); emit(turnEnd({ kind: 'completed' }))
    })
    const result = await runTurn(options(a))
    expect(result.outcome).toBe('sent')
    const sends = api.callsTo('sendMessage').slice(1)
    expect(sends).toHaveLength(3)
    expect(sends[0]!.args[1]).toContain('<blockquote expandable>')
    expect(sends[1]!.args[1]).not.toContain('<blockquote expandable>')
    expect(sends[2]!.args[2]).toEqual({ replyTo: { messageId: 10 } })
  })

  it('sends a markdown document when the rendered message exceeds 4096 bytes', async () => {
    const long = 'line of text that is long enough\n'.repeat(200)
    const a = fakeAgent(emit => { emit(turnStart); emit(reply(long)); emit(turnEnd({ kind: 'completed' })) })
    const result = await runTurn(options(a))
    expect(result.outcome).toBe('document')
    expect(api.callsTo('deleteMessage')[0]?.args).toEqual([5, 100])
    const [, data, opts] = api.callsTo('sendDocument')[0]!.args as [number, Buffer, { filename: string; caption: string; replyTo: object }]
    expect(data.toString('utf8')).toBe(UTF8_BOM + long)
    expect(opts.filename).toMatch(/^response-\d+\.md$/)
    expect(Buffer.byteLength(opts.caption)).toBeLessThanOrEqual(1024)
    expect(opts.replyTo).toEqual({ messageId: 10 })
    expect(await readdir(join(dir, 'outbox'))).toHaveLength(1)
  })

  it('reports undelivered when the document upload fails, without a truncated fallback', async () => {
    const long = 'x'.repeat(5000)
    const a = fakeAgent(emit => { emit(turnStart); emit(reply(long)); emit(turnEnd({ kind: 'completed' })) })
    api.failNext('sendDocument', new TelegramApiError('too big', 413))
    const result = await runTurn(options(a))
    expect(result.outcome).toBe('undelivered')
    expect(api.callsTo('sendMessage').at(-1)!.args[1]).toBe(UNDELIVERED_NOTICE)
    expect(api.callsTo('sendMessage')).toHaveLength(2)
  })

  it('shows a warning when the turn ends in error', async () => {
    const a = fakeAgent(emit => { emit(turnStart); emit(turnEnd({ kind: 'error', error: { code: 'LLM_AUTH', message: 'bad key' } })) })
    const result = await runTurn(options(a))
    expect(result.outcome).toBe('error')
    expect(api.callsTo('editMessageText').at(-1)!.args[2]).toBe('Error: LLM_AUTH: bad key')
  })

  it('cancels and reports a timeout', async () => {
    let release!: () => void
    const a = fakeAgent(emit => { emit(turnStart); return new Promise<void>(resolve => { release = resolve }) })
    const result = await runTurn(options(a, { turnTimeoutMs: 5 }))
    release()
    expect(result.outcome).toBe('timeout')
    expect(api.callsTo('editMessageText').at(-1)!.args[2]).toMatch(/timed out/)
  })

  it('reports stopped when the turn was aborted', async () => {
    const a = fakeAgent(emit => { emit(turnStart); emit(turnEnd({ kind: 'aborted', reason: { kind: 'user' } })) })
    const result = await runTurn(options(a))
    expect(result.outcome).toBe('stopped')
    expect(api.callsTo('editMessageText').at(-1)!.args[2]).toBe('Stopped.')
  })

  it('reports empty when the agent produced no text', async () => {
    const a = fakeAgent(emit => { emit(turnStart); emit(turnEnd({ kind: 'completed' })) })
    const result = await runTurn(options(a))
    expect(result.outcome).toBe('empty')
    expect(api.callsTo('editMessageText').at(-1)!.args[2]).toBe('(no reply)')
  })
})
