import { describe, expect, it, vi } from 'vitest'
import { runTurn, startTyping, type TurnOptions } from '../src/turn.ts'
import { FakeZaloApi } from './helpers/fake-api.ts'

/** Agent whose followup appends one turn's events; `hang` leaves the turn open until cancelled. */
function fakeAgent(reply: { text?: string; reason?: Record<string, unknown>; hang?: boolean }) {
  const events: Array<{ type: string; data: unknown }> = []
  let release = () => {}
  const end = (reason: Record<string, unknown>) => events.push({ type: 'turn/end', data: { reason } })
  return {
    id: 's1',
    session: { get seq() { return events.length }, eventAt: (seq: number) => events[seq] as never },
    followup: () => {
      events.push({ type: 'turn/start', data: {} })
      if (reply.text !== undefined) events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply.text }] } } })
      if (!reply.hang) end(reply.reason ?? { kind: 'completed' })
    },
    whenIdle: () => (reply.hang ? new Promise<void>((resolve) => { release = resolve }) : Promise.resolve()),
    cancel: () => { end({ kind: 'aborted' }); release() },
  }
}

const log = { warn: vi.fn(), error: vi.fn() }
function options(api: FakeZaloApi, agent: ReturnType<typeof fakeAgent>, extra: Partial<TurnOptions> = {}): TurnOptions {
  return { api, agent: agent as never, chatId: 'c1', content: [{ type: 'text', text: 'q' }], messageSize: 2000, typingIntervalMs: 60_000, turnTimeoutMs: 60_000, log, ...extra }
}
const sent = (api: FakeZaloApi) => api.callsTo('sendMessage').map(c => c.args[1])

describe('runTurn', () => {
  it('shows typing and sends the reply as markdown', async () => {
    const api = new FakeZaloApi()
    const result = await runTurn(options(api, fakeAgent({ text: '**hi**' })))
    expect(api.callsTo('sendChatAction')[0]!.args).toEqual(['c1', 'typing'])
    expect(api.callsTo('sendMessage')[0]!.args).toEqual(['c1', '**hi**', { parseMode: 'markdown' }])
    expect(result).toMatchObject({ outcome: 'sent', text: '**hi**', sentMessageId: 'm100' })
  })

  it('sends a long reply as ordered chunks within messageSize', async () => {
    const api = new FakeZaloApi()
    await runTurn(options(api, fakeAgent({ text: `${'a'.repeat(400)}\n\n${'b'.repeat(400)}` }), { messageSize: 500 }))
    expect(sent(api)).toEqual(['a'.repeat(400), 'b'.repeat(400)])
  })

  it('resends a chunk Zalo rejects as plain text', async () => {
    const api = new FakeZaloApi()
    api.failNext('sendMessage', new Error('bad markdown'))
    const result = await runTurn(options(api, fakeAgent({ text: '| a | b |' })))
    expect(api.callsTo('sendMessage').map(c => c.args[2])).toEqual([{ parseMode: 'markdown' }, undefined])
    expect(result.outcome).toBe('sent')
  })

  it('reports undelivered when plain text fails too', async () => {
    const api = new FakeZaloApi()
    api.failNext('sendMessage', new Error('a'))
    api.failNext('sendMessage', new Error('b'))
    const result = await runTurn(options(api, fakeAgent({ text: 'x' })))
    expect(result.outcome).toBe('undelivered')
    expect(log.error).toHaveBeenCalled()
  })

  it('still replies when typing fails', async () => {
    const api = new FakeZaloApi()
    api.failNext('sendChatAction', new Error('nope'))
    expect((await runTurn(options(api, fakeAgent({ text: 'ok' })))).outcome).toBe('sent')
  })

  it('maps error, aborted and empty turns to short notices', async () => {
    const api = new FakeZaloApi()
    expect((await runTurn(options(api, fakeAgent({ reason: { kind: 'error', error: { code: 'E', message: 'boom' } } })))).outcome).toBe('error')
    expect((await runTurn(options(api, fakeAgent({ reason: { kind: 'aborted' } })))).outcome).toBe('stopped')
    expect((await runTurn(options(api, fakeAgent({})))).outcome).toBe('empty')
    expect(sent(api)).toEqual(['Error: E: boom', 'Stopped.', '(no reply)'])
  })

  it('cancels a turn that runs past turnTimeoutMs', async () => {
    const api = new FakeZaloApi()
    const result = await runTurn(options(api, fakeAgent({ hang: true }), { turnTimeoutMs: 10 }))
    expect(result.outcome).toBe('timeout')
    expect(sent(api)[0]).toMatch(/timed out/)
  })
})

describe('startTyping', () => {
  it('repeats until stopped', async () => {
    vi.useFakeTimers()
    const api = new FakeZaloApi()
    const stop = startTyping(api, 'c1', 4000, log)
    await vi.advanceTimersByTimeAsync(8100)
    stop()
    await vi.advanceTimersByTimeAsync(8000)
    expect(api.callsTo('sendChatAction')).toHaveLength(3)
    vi.useRealTimers()
  })
})
