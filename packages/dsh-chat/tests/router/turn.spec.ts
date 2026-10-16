import { describe, expect, it } from 'vitest'
import type { TurnReport, TurnSink } from '../../src/router/channel.ts'
import { runAgentTurn, summarizeTurn, type SessionEventFeed, type TurnAgent } from '../../src/router/turn.ts'

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
    session: { get seq() { return events.length }, eventAt: (seq: number) => events[seq] as never },
    followup: () => { running = Promise.resolve().then(() => script(emit)) },
    whenIdle: () => running,
    cancel: () => { emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'cancelled' } } }) },
  }
  const feed: SessionEventFeed = (listener) => {
    listeners.add(listener as never)
    return () => listeners.delete(listener as never)
  }
  return { agent, feed, events }
}

const reply = (text: string): AnyEvent => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } } })
const toolCall = (name: string): AnyEvent => ({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c', name, arguments: '{}' } })
const turnStart: AnyEvent = { type: 'turn/start', data: { turn: 1 } }
const turnEnd = (reason: object): AnyEvent => ({ type: 'turn/end', data: { turn: 1, reason } })

function recordingSink(deliverImpl?: (report: TurnReport) => Promise<{ outcome: string; messageId?: string }>) {
  const calls: { status: string[]; reports: TurnReport[]; closed: number } = { status: [], reports: [], closed: 0 }
  const sink: TurnSink = {
    status: (tool) => { calls.status.push(tool) },
    deliver: async (report) => {
      calls.reports.push(report)
      return deliverImpl === undefined ? { outcome: 'sent', messageId: 'm1' } : deliverImpl(report)
    },
    close: () => { calls.closed++ },
  }
  return { sink, calls }
}

const content = [{ type: 'text' as const, text: 'hi' }]

describe('summarizeTurn', () => {
  it('keeps the last assistant text, the error and the abort flag after turn/start', () => {
    const events = [reply('before'), turnStart, reply('one'), reply('two'), turnEnd({ kind: 'error', error: { code: 'X', message: 'bad' } })]
    const session = { seq: events.length, eventAt: (seq: number) => events[seq] as never }
    expect(summarizeTurn(session, 0)).toEqual({ text: 'two', aborted: false, error: 'X: bad' })
  })
})

describe('runAgentTurn', () => {
  it('delivers a reply, forwards tool names to the sink and closes it', async () => {
    const a = fakeAgent((emit) => { emit(turnStart); emit(toolCall('bash')); emit(reply('done')); emit(turnEnd({ kind: 'completed' })) })
    const { sink, calls } = recordingSink()
    const result = await runAgentTurn({ agent: a.agent, feed: a.feed, content, sink, turnTimeoutMs: 10_000 })
    expect(calls.status).toEqual(['bash'])
    expect(calls.reports).toEqual([{ kind: 'reply', text: 'done', timeoutMs: 10_000 }])
    expect(calls.closed).toBe(1)
    expect(result).toMatchObject({ outcome: 'sent', text: 'done', messageId: 'm1' })
  })

  it('cancels and reports a timeout', async () => {
    let release!: () => void
    const a = fakeAgent((emit) => { emit(turnStart); return new Promise<void>((resolve) => { release = resolve }) })
    const { sink, calls } = recordingSink()
    await runAgentTurn({ agent: a.agent, feed: a.feed, content, sink, turnTimeoutMs: 20 })
    release()
    expect(calls.reports[0]!.kind).toBe('timeout')
  })

  it('maps error, aborted and empty turns', async () => {
    const cases: [AnyEvent[], TurnReport['kind']][] = [
      [[turnStart, turnEnd({ kind: 'error', error: { code: 'LLM_AUTH', message: 'no key' } })], 'error'],
      [[turnStart, turnEnd({ kind: 'aborted', reason: { kind: 'user' } })], 'stopped'],
      [[turnStart, reply('   '), turnEnd({ kind: 'completed' })], 'empty'],
    ]
    for (const [events, kind] of cases) {
      const a = fakeAgent((emit) => { for (const e of events) emit(e) })
      const { sink, calls } = recordingSink()
      const result = await runAgentTurn({ agent: a.agent, feed: a.feed, content, sink, turnTimeoutMs: 10_000 })
      expect(calls.reports[0]!.kind).toBe(kind)
      if (kind === 'empty') expect(result.text).toBe('')
      if (kind === 'error') expect(calls.reports[0]!.error).toBe('LLM_AUTH: no key')
    }
  })

  it('closes the sink when delivery throws', async () => {
    const a = fakeAgent((emit) => { emit(turnStart); emit(reply('x')); emit(turnEnd({ kind: 'completed' })) })
    const { sink, calls } = recordingSink(async () => { throw new Error('send failed') })
    await expect(runAgentTurn({ agent: a.agent, feed: a.feed, content, sink, turnTimeoutMs: 10_000 })).rejects.toThrow('send failed')
    expect(calls.closed).toBe(1)
  })
})
