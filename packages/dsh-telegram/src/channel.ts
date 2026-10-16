import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatChannel, TurnReport, TurnSink } from 'dsh-chat'
import type { Config } from './config.ts'
import {
  CAPTION_MAX_BYTES,
  TELEGRAM_MAX_MESSAGE_BYTES,
  UNDELIVERED_NOTICE,
  UTF8_BOM,
  byteLength,
  captionPrefix,
  markdownToTelegramHTML,
  renderMessage,
  stripCollapse,
  toolStatus,
} from './render.ts'
import type { ReplyTarget, TelegramApi } from './telegram-api.ts'

/** Reaction placed on every message the agent will answer. */
export const ACK_REACTION = '\u{1F47E}'

export interface TelegramChannelDeps {
  api: TelegramApi
  bot: { id: number; username: string }
  config: Pick<Config, 'messageSize' | 'statusEditIntervalMs' | 'status'>
  /** Where a too-long answer is written before it is sent as a document. */
  outboxFor(chatId: number): string
  log: { warn(msg: string): void; error(msg: string): void }
  now?: () => number
}

export type TurnOutcome = 'edited' | 'sent' | 'document' | 'undelivered' | 'error' | 'timeout' | 'stopped' | 'empty'

/** Throttled placeholder editor that never repeats the visible text. */
class Placeholder {
  private shown: string
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
    initialText: string,
  ) {
    this.shown = initialText
  }

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

/** Reply parameters for a send; empty when the turn answers no message. */
function replyTarget(messageId: number | undefined): { replyTo?: ReplyTarget } {
  return messageId === undefined ? {} : { replyTo: { messageId } }
}

async function sendPart(api: TelegramApi, chatId: number, part: string, replyToMessageId: number | undefined, log: TelegramChannelDeps['log']): Promise<number> {
  const reply = replyTarget(replyToMessageId)
  try {
    return (await api.sendMessage(chatId, part, { parseMode: 'HTML', ...reply })).messageId
  } catch (error) {
    log.warn(`dsh-telegram: HTML send rejected (${String(error)})`)
  }
  const stripped = stripCollapse(part)
  if (stripped !== part) {
    try {
      return (await api.sendMessage(chatId, stripped, { parseMode: 'HTML', ...reply })).messageId
    } catch (error) {
      log.warn(`dsh-telegram: send without collapse rejected (${String(error)})`)
    }
  }
  return (await api.sendMessage(chatId, part, { ...reply })).messageId
}

interface TurnTarget { deps: TelegramChannelDeps; chatId: number; replyTo?: number }

async function sendMarkdownDocument(target: TurnTarget, markdown: string, html: string): Promise<number> {
  const outboxDir = target.deps.outboxFor(target.chatId)
  await mkdir(outboxDir, { recursive: true })
  const filename = `response-${Date.now()}.md`
  const data = Buffer.from(UTF8_BOM + markdown, 'utf8')
  await writeFile(join(outboxDir, filename), data)
  const sent = await target.deps.api.sendDocument(target.chatId, data, {
    filename,
    caption: captionPrefix(html, CAPTION_MAX_BYTES),
    parseMode: 'HTML',
    ...replyTarget(target.replyTo),
  })
  return sent.messageId
}

/** Turns the report into what the chat sees: placeholder text, a fresh message, or a document. */
async function deliver(target: TurnTarget, placeholder: Placeholder, report: TurnReport): Promise<{ outcome: TurnOutcome; sentMessageId?: number }> {
  const { deps, chatId } = target
  const placeholderId = placeholder.messageId
  if (report.kind === 'timeout') {
    await placeholder.replace(`The reply timed out after ${Math.round(report.timeoutMs / 1000)}s and was stopped.`)
    return { outcome: 'timeout', sentMessageId: placeholderId }
  }
  if (report.kind === 'error') {
    await placeholder.replace(`Error: ${report.error}`)
    return { outcome: 'error', sentMessageId: placeholderId }
  }
  if (report.kind === 'stopped') {
    await placeholder.replace('Stopped.')
    return { outcome: 'stopped', sentMessageId: placeholderId }
  }
  if (report.kind === 'empty') {
    await placeholder.replace('(no reply)')
    return { outcome: 'empty', sentMessageId: placeholderId }
  }

  const html = markdownToTelegramHTML(report.text)
  const rendered = renderMessage(html, deps.config.messageSize)

  if (byteLength(rendered) > TELEGRAM_MAX_MESSAGE_BYTES) {
    await placeholder.drop()
    try {
      return { outcome: 'document', sentMessageId: await sendMarkdownDocument(target, report.text, html) }
    } catch (error) {
      deps.log.error(`dsh-telegram: markdown document send failed (${String(error)})`)
      await deps.api.sendMessage(chatId, UNDELIVERED_NOTICE, { ...replyTarget(target.replyTo) })
      return { outcome: 'undelivered' }
    }
  }

  if (await placeholder.replace(rendered, 'HTML')) return { outcome: 'edited', sentMessageId: placeholderId }
  await placeholder.drop()
  return { outcome: 'sent', sentMessageId: await sendPart(deps.api, chatId, rendered, target.replyTo, deps.log) }
}

async function openTurn(deps: TelegramChannelDeps, chatId: number, replyTo: number | undefined): Promise<TurnSink> {
  const { api, log } = deps
  const now = deps.now ?? Date.now
  // The reaction is a courtesy; a chat with reactions disabled must still get its answer.
  if (replyTo !== undefined) {
    await api.setReaction(chatId, replyTo, ACK_REACTION).catch((error: unknown) => {
      log.warn(`dsh-telegram: chat ${chatId} acknowledgement reaction failed (${String(error)})`)
    })
  }
  await api.sendChatAction(chatId, 'typing').catch((error: unknown) => {
    log.warn(`dsh-telegram: typing indicator failed (${String(error)})`)
  })
  const { status } = deps.config
  const placeholderId = (await api.sendMessage(chatId, status.thinking, { ...replyTarget(replyTo) })).messageId
  const placeholder = new Placeholder(api, chatId, placeholderId, deps.config.statusEditIntervalMs, now, status.thinking)
  const target: TurnTarget = { deps, chatId, ...(replyTo === undefined ? {} : { replyTo }) }
  return {
    status: tool => placeholder.status(toolStatus(tool, status)),
    deliver: async (report) => {
      const delivered = await deliver(target, placeholder, report)
      return { outcome: delivered.outcome, ...(delivered.sentMessageId === undefined ? {} : { messageId: String(delivered.sentMessageId) }) }
    },
    close: () => { void placeholder.settle() },
  }
}

export function createTelegramChannel(deps: TelegramChannelDeps): ChatChannel {
  return {
    id: 'telegram',
    bot: { id: String(deps.bot.id), name: deps.bot.username },
    openTurn: (chatId, origin) => openTurn(deps, Number(chatId), origin.replyTo === undefined ? undefined : Number(origin.replyTo)),
    async send(chatId, text, opts = {}) {
      const sent = await deps.api.sendMessage(Number(chatId), text, { ...replyTarget(opts.replyTo === undefined ? undefined : Number(opts.replyTo)) })
      return { as: 'native', messageId: String(sent.messageId), text }
    },
    async react(chatId, messageId, emoji) {
      await deps.api.setReaction(Number(chatId), Number(messageId), emoji)
      return { as: 'native' }
    },
  }
}
