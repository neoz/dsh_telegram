import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  CAPTION_MAX_BYTES,
  TELEGRAM_MAX_MESSAGE_BYTES,
  THINKING_TEXT,
  UNDELIVERED_NOTICE,
  UTF8_BOM,
  byteLength,
  captionPrefix,
  markdownToTelegramHTML,
  renderMessage,
  stripCollapse,
  summarizeToolCall,
} from './render.ts'
import type { TelegramApi } from './telegram-api.ts'

export const STATUS_MAX_CHARS = 60

/** Structural slice of dsh's Agent used by the runner (the real Agent satisfies it). */
export interface TurnAgent {
  readonly id: string
  readonly session: {
    readonly seq: number
    eventAt(seq: SessionSeq): SessionEvent | undefined
    readonly header: { readonly cwd?: string }
  }
  followup(message: UserMessage): void
  whenIdle(): Promise<void>
  cancel(cause: { kind: 'user' }): void
}

/** Session event feed abstraction over `ctx.on('session/event')`. */
export type SessionEventFeed = (listener: (sessionId: string, event: SessionEvent) => void) => () => void

export interface TurnOptions {
  api: TelegramApi
  agent: TurnAgent
  feed: SessionEventFeed
  chatId: number
  replyToMessageId: number
  content: ContentBlock[]
  outboxDir: string
  messageSize: number
  statusEditIntervalMs: number
  turnTimeoutMs: number
  log: { warn(msg: string): void; error(msg: string): void }
  now?: () => number
}

export type TurnOutcome = 'edited' | 'sent' | 'document' | 'undelivered' | 'error' | 'timeout' | 'empty'

export interface TurnResult {
  outcome: TurnOutcome
  text: string
  sentMessageId?: number
}

/** Last assistant text and any error reason inside the turn(s) since `firstSeq`. */
export function summarizeTurn(session: TurnAgent['session'], firstSeq: number): { text: string; error?: string } {
  let started = false
  let text = ''
  let error: string | undefined
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
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
      const reason = event.data.reason as { kind: 'error'; error: { code: string; message: string } }
      error = `${reason.error.code}: ${reason.error.message}`
    }
  }
  return error === undefined ? { text } : { text, error }
}

/** Throttled placeholder editor that never repeats the visible text. */
class Placeholder {
  private shown = THINKING_TEXT
  private pending: string | undefined
  private timer: NodeJS.Timeout | undefined
  private lastEdit = 0
  private chain = Promise.resolve()

  constructor(
    private readonly api: TelegramApi,
    private readonly chatId: number,
    readonly messageId: number,
    private readonly intervalMs: number,
    private readonly now: () => number,
  ) {}

  status(text: string): void {
    if (text === this.shown || text === this.pending) return
    this.pending = text
    if (this.timer !== undefined) return
    const wait = Math.max(0, this.lastEdit + this.intervalMs - this.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, wait)
  }

  private flush(): Promise<void> {
    const text = this.pending
    this.pending = undefined
    if (text === undefined || text === this.shown) return this.chain
    this.chain = this.chain.then(async () => {
      try {
        await this.api.editMessageText(this.chatId, this.messageId, text)
        this.shown = text
        this.lastEdit = this.now()
      } catch {
        // A failed status edit leaves the old text on screen; the next status retries.
      }
    })
    return this.chain
  }

  /** Stop status edits and wait for in-flight ones. */
  async settle(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.pending = undefined
    await this.chain
  }

  async replace(text: string, parseMode?: 'HTML'): Promise<boolean> {
    await this.settle()
    try {
      await this.api.editMessageText(this.chatId, this.messageId, text, parseMode === undefined ? {} : { parseMode })
      return true
    } catch {
      return false
    }
  }

  async drop(): Promise<void> {
    await this.settle()
    try {
      await this.api.deleteMessage(this.chatId, this.messageId)
    } catch {
      // Already gone; nothing to clean up.
    }
  }
}

async function sendPart(api: TelegramApi, chatId: number, part: string, replyToMessageId: number, log: TurnOptions['log']): Promise<number> {
  const replyTo = { messageId: replyToMessageId }
  try {
    return (await api.sendMessage(chatId, part, { parseMode: 'HTML', replyTo })).messageId
  } catch (error) {
    log.warn(`dsh-telegram: HTML send rejected (${String(error)})`)
  }
  const stripped = stripCollapse(part)
  if (stripped !== part) {
    try {
      return (await api.sendMessage(chatId, stripped, { parseMode: 'HTML', replyTo })).messageId
    } catch (error) {
      log.warn(`dsh-telegram: send without collapse rejected (${String(error)})`)
    }
  }
  return (await api.sendMessage(chatId, part, { replyTo })).messageId
}

async function sendMarkdownDocument(options: TurnOptions, markdown: string, html: string): Promise<number> {
  await mkdir(options.outboxDir, { recursive: true })
  const filename = `response-${Date.now()}.md`
  const data = Buffer.from(UTF8_BOM + markdown, 'utf8')
  await writeFile(join(options.outboxDir, filename), data)
  const sent = await options.api.sendDocument(options.chatId, data, {
    filename,
    caption: captionPrefix(html, CAPTION_MAX_BYTES),
    parseMode: 'HTML',
    replyTo: { messageId: options.replyToMessageId },
  })
  return sent.messageId
}

export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const { api, agent, chatId, log } = options
  const now = options.now ?? Date.now
  await api.sendChatAction(chatId, 'typing')
  const placeholderId = (await api.sendMessage(chatId, THINKING_TEXT, { replyTo: { messageId: options.replyToMessageId } })).messageId
  const placeholder = new Placeholder(api, chatId, placeholderId, options.statusEditIntervalMs, now)

  const firstSeq = agent.session.seq
  const unsubscribe = options.feed((sessionId, event) => {
    if (sessionId !== agent.id || event.type !== 'tool/call') return
    placeholder.status(summarizeToolCall(event.data.name, event.data.arguments, STATUS_MAX_CHARS))
  })

  let timedOut = false
  let timer: NodeJS.Timeout | undefined
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

  const summary = summarizeTurn(agent.session, firstSeq)
  if (timedOut) {
    await placeholder.replace(`The reply timed out after ${Math.round(options.turnTimeoutMs / 1000)}s and was stopped.`)
    return { outcome: 'timeout', text: summary.text, sentMessageId: placeholderId }
  }
  if (summary.error !== undefined) {
    await placeholder.replace(`Error: ${summary.error}`)
    return { outcome: 'error', text: summary.text, sentMessageId: placeholderId }
  }
  if (summary.text === '') {
    await placeholder.replace('(no reply)')
    return { outcome: 'empty', text: '', sentMessageId: placeholderId }
  }

  const html = markdownToTelegramHTML(summary.text)
  const rendered = renderMessage(html, options.messageSize)

  if (byteLength(rendered) > TELEGRAM_MAX_MESSAGE_BYTES) {
    await placeholder.drop()
    try {
      const sentMessageId = await sendMarkdownDocument(options, summary.text, html)
      return { outcome: 'document', text: summary.text, sentMessageId }
    } catch (error) {
      log.error(`dsh-telegram: markdown document send failed (${String(error)})`)
      await api.sendMessage(chatId, UNDELIVERED_NOTICE, { replyTo: { messageId: options.replyToMessageId } })
      return { outcome: 'undelivered', text: summary.text }
    }
  }

  if (await placeholder.replace(rendered, 'HTML')) {
    return { outcome: 'edited', text: summary.text, sentMessageId: placeholderId }
  }
  await placeholder.drop()
  const sentMessageId = await sendPart(api, chatId, rendered, options.replyToMessageId, log)
  return { outcome: 'sent', text: summary.text, sentMessageId }
}
