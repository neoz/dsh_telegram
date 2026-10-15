import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { splitMessage } from './render.ts'
import type { ZaloApi } from './zalo-api.ts'

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

export interface TurnOptions {
  api: ZaloApi
  agent: TurnAgent
  chatId: string
  content: ContentBlock[]
  messageSize: number
  typingIntervalMs: number
  turnTimeoutMs: number
  log: { warn(msg: string): void; error(msg: string): void }
  now?: () => number
}

export type TurnOutcome = 'sent' | 'undelivered' | 'error' | 'timeout' | 'stopped' | 'empty'

export interface TurnResult {
  outcome: TurnOutcome
  text: string
  /** Id of the last message sent for this turn. */
  sentMessageId?: string
  /** Wall-clock breakdown: agent work versus Zalo delivery. */
  timing: { agentMs: number; deliverMs: number }
}

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

/** Zalo has no editable status message; the typing indicator repeats until the returned stop is called. Failures warn once. */
export function startTyping(api: ZaloApi, chatId: string, intervalMs: number, log: { warn(msg: string): void }): () => void {
  let warned = false
  const send = () => {
    api.sendChatAction(chatId, 'typing').catch((error: unknown) => {
      if (warned) return
      warned = true
      log.warn(`dsh-zalo: typing indicator failed in chat ${chatId} (${String(error)})`)
    })
  }
  send()
  const timer = setInterval(send, intervalMs)
  return () => clearInterval(timer)
}

/** Sends one chunk as markdown, then as plain text if Zalo rejects the markup; undefined when both fail. */
async function sendPart(api: ZaloApi, chatId: string, part: string, log: TurnOptions['log']): Promise<string | undefined> {
  try {
    return (await api.sendMessage(chatId, part, { parseMode: 'markdown' })).messageId
  } catch (error) {
    log.warn(`dsh-zalo: markdown send rejected in chat ${chatId} (${String(error)}); retrying as plain text`)
  }
  try {
    return (await api.sendMessage(chatId, part)).messageId
  } catch (error) {
    log.error(`dsh-zalo: plain send failed in chat ${chatId} (${String(error)})`)
    return undefined
  }
}

async function notice(options: TurnOptions, text: string): Promise<string | undefined> {
  try {
    return (await options.api.sendMessage(options.chatId, text)).messageId
  } catch (error) {
    options.log.error(`dsh-zalo: notice failed in chat ${options.chatId} (${String(error)})`)
    return undefined
  }
}

type Delivery = Omit<TurnResult, 'timing'>

const withId = (id: string | undefined) => (id === undefined ? {} : { sentMessageId: id })

async function deliver(options: TurnOptions, summary: TurnSummary, timedOut: boolean): Promise<Delivery> {
  if (timedOut) {
    const id = await notice(options, `The reply timed out after ${Math.round(options.turnTimeoutMs / 1000)}s and was stopped.`)
    return { outcome: 'timeout', text: summary.text, ...withId(id) }
  }
  if (summary.error !== undefined) return { outcome: 'error', text: summary.text, ...withId(await notice(options, `Error: ${summary.error}`)) }
  if (summary.aborted) return { outcome: 'stopped', text: summary.text, ...withId(await notice(options, 'Stopped.')) }
  if (summary.text.trim() === '') return { outcome: 'empty', text: '', ...withId(await notice(options, '(no reply)')) }

  let lastId: string | undefined
  for (const part of splitMessage(summary.text, options.messageSize)) {
    const id = await sendPart(options.api, options.chatId, part, options.log)
    if (id === undefined) return { outcome: 'undelivered', text: summary.text, ...withId(lastId) }
    lastId = id
  }
  return { outcome: 'sent', text: summary.text, ...withId(lastId) }
}

export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const { agent } = options
  const now = options.now ?? Date.now
  const stopTyping = startTyping(options.api, options.chatId, options.typingIntervalMs, options.log)
  const firstSeq = agent.session.seq
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
    stopTyping()
  }
  const agentMs = now() - agentStart

  const summary = summarizeTurn(agent.session, firstSeq)
  const deliverStart = now()
  const delivered = await deliver(options, summary, timedOut)
  return { ...delivered, timing: { agentMs, deliverMs: now() - deliverStart } }
}
