import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TurnReport, TurnSink } from './channel.ts'

/** Structural slice of dsh's Agent used by the runner (the real Agent satisfies it). */
export interface TurnAgent {
  readonly id: string
  readonly session: {
    readonly seq: number
    eventAt(seq: SessionSeq): SessionEvent | undefined
  }
  followup(message: UserMessage): void
  whenIdle(): Promise<void>
  cancel(cause: { kind: 'user' }): void
}

/** Session event feed abstraction over `ctx.on('session/event')`. */
export type SessionEventFeed = (listener: (sessionId: string, event: SessionEvent) => void) => () => void

export interface TurnSummary { text: string; error?: string; aborted: boolean }

/** Last assistant text, any error reason, and whether the turn was cancelled, since `firstSeq`. */
export function summarizeTurn(session: TurnAgent['session'], firstSeq: number): TurnSummary {
  let started = false
  let text = ''
  let error: string | undefined
  let aborted = false
  for (let seq = firstSeq; seq < session.seq; seq++) {
    const event = session.eventAt(seq as SessionSeq)
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason as { kind: string; error?: { code: string; message: string } }
      if (reason.kind === 'error' && reason.error !== undefined) error = `${reason.error.code}: ${reason.error.message}`
      if (reason.kind === 'aborted') aborted = true
    }
  }
  return { text, aborted, ...(error === undefined ? {} : { error }) }
}

export interface AgentTurnOptions {
  agent: TurnAgent
  feed: SessionEventFeed
  content: ContentBlock[]
  sink: TurnSink
  turnTimeoutMs: number
  now?: () => number
}

export interface AgentTurnResult {
  /** The channel's word for what it delivered. */
  outcome: string
  /** The agent's final text; empty when the turn produced none. */
  text: string
  messageId?: string
  /** Wall-clock breakdown: agent work versus delivery. */
  timing: { agentMs: number; deliverMs: number }
}

function reportOf(summary: TurnSummary, timedOut: boolean, timeoutMs: number): TurnReport {
  if (timedOut) return { kind: 'timeout', text: summary.text, timeoutMs }
  if (summary.error !== undefined) return { kind: 'error', text: summary.text, error: summary.error, timeoutMs }
  if (summary.aborted) return { kind: 'stopped', text: summary.text, timeoutMs }
  if (summary.text.trim() === '') return { kind: 'empty', text: '', timeoutMs }
  return { kind: 'reply', text: summary.text, timeoutMs }
}

/** Submits `content`, waits for the agent or the timeout, and lets the sink render the end; the sink is always closed. */
export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const { agent, sink } = options
  const now = options.now ?? Date.now
  try {
    const firstSeq = agent.session.seq
    const unsubscribe = options.feed((sessionId, event) => {
      if (sessionId === agent.id && event.type === 'tool/call') sink.status(event.data.name)
    })
    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    const agentStart = now()
    try {
      agent.followup(createUserMessage({ content: options.content, source: { kind: 'user' } }))
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          agent.cancel({ kind: 'user' })
          resolve()
        }, options.turnTimeoutMs)
      })
      await Promise.race([agent.whenIdle(), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
    }
    const agentMs = now() - agentStart
    const report = reportOf(summarizeTurn(agent.session, firstSeq), timedOut, options.turnTimeoutMs)
    const deliverStart = now()
    const delivered = await sink.deliver(report)
    return {
      outcome: delivered.outcome,
      text: report.text,
      ...(delivered.messageId === undefined ? {} : { messageId: delivered.messageId }),
      timing: { agentMs, deliverMs: now() - deliverStart },
    }
  } finally {
    sink.close()
  }
}
