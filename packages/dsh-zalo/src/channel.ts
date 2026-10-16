import type { ChatChannel, Delivered, TurnReport, TurnSink } from 'dsh-chat'
import type { Config } from './config.ts'
import { splitMessage } from './render.ts'
import { ZaloApiError, type ZaloApi } from './zalo-api.ts'

export interface ZaloChannelDeps {
  api: ZaloApi
  bot: { id: string; accountName: string }
  config: Pick<Config, 'messageSize' | 'typingIntervalMs' | 'stickers'>
  log: { warn(msg: string): void; error(msg: string): void }
}

export type TurnOutcome = 'sent' | 'undelivered' | 'error' | 'timeout' | 'stopped' | 'empty'

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

/** Zalo answered and refused the request; anything else may have been delivered, so resending risks a duplicate. */
const isRejection = (error: unknown) => error instanceof ZaloApiError && error.code !== undefined && error.code >= 400 && error.code < 500 && error.code !== 429

/** Sends one chunk as markdown, then as plain text if Zalo rejects the markup; undefined when it is not delivered. */
async function sendPart(api: ZaloApi, chatId: string, part: string, log: ZaloChannelDeps['log']): Promise<string | undefined> {
  try {
    return (await api.sendMessage(chatId, part, { parseMode: 'markdown' })).messageId
  } catch (error) {
    if (!isRejection(error)) {
      log.error(`dsh-zalo: send failed in chat ${chatId} (${String(error)})`)
      return undefined
    }
    log.warn(`dsh-zalo: markdown send rejected in chat ${chatId} (${String(error)}); retrying as plain text`)
  }
  try {
    return (await api.sendMessage(chatId, part)).messageId
  } catch (error) {
    log.error(`dsh-zalo: plain send failed in chat ${chatId} (${String(error)})`)
    return undefined
  }
}

async function notice(deps: ZaloChannelDeps, chatId: string, text: string): Promise<string | undefined> {
  try {
    return (await deps.api.sendMessage(chatId, text)).messageId
  } catch (error) {
    deps.log.error(`dsh-zalo: notice failed in chat ${chatId} (${String(error)})`)
    return undefined
  }
}

/** Emoji compare without the U+FE0F variation selector, as idle already normalizes them. */
const plain = (emoji: string) => emoji.replaceAll('\u{FE0F}', '')

/** Zalo may answer without a message id; an empty id is no id, so nothing is logged under it. */
const withId = (outcome: TurnOutcome, id: string | undefined) => ({ outcome, ...(id === undefined || id === '' ? {} : { messageId: id }) })
const posted = (as: Delivered['as'], id: string, text: string): Delivered => (id === '' ? { as } : { as, messageId: id, text })

async function deliver(deps: ZaloChannelDeps, chatId: string, report: TurnReport): Promise<{ outcome: TurnOutcome; messageId?: string }> {
  if (report.kind === 'timeout') return withId('timeout', await notice(deps, chatId, `The reply timed out after ${Math.round(report.timeoutMs / 1000)}s and was stopped.`))
  if (report.kind === 'error') return withId('error', await notice(deps, chatId, `Error: ${report.error}`))
  if (report.kind === 'stopped') return withId('stopped', await notice(deps, chatId, 'Stopped.'))
  if (report.kind === 'empty') return withId('empty', await notice(deps, chatId, '(no reply)'))
  let lastId: string | undefined
  for (const part of splitMessage(report.text, deps.config.messageSize)) {
    const id = await sendPart(deps.api, chatId, part, deps.log)
    if (id === undefined) return withId('undelivered', lastId)
    if (id !== '') lastId = id
  }
  return withId('sent', lastId)
}

export function createZaloChannel(deps: ZaloChannelDeps): ChatChannel {
  return {
    id: 'zalo',
    bot: { id: deps.bot.id, name: deps.bot.accountName },
    // Zalo cannot quote a message, so the origin is not used.
    async openTurn(chatId): Promise<TurnSink> {
      const stopTyping = startTyping(deps.api, chatId, deps.config.typingIntervalMs, deps.log)
      return {
        status: () => {},
        deliver: (report) => {
          stopTyping()
          return deliver(deps, chatId, report)
        },
        close: stopTyping,
      }
    },
    async send(chatId, text, opts = {}) {
      const sent = await deps.api.sendMessage(chatId, text)
      return posted(opts.replyTo === undefined ? 'native' : 'fallback', sent.messageId, text)
    },
    // Zalo has no reactions: a mapped sticker stands in, any other emoji is posted as text.
    async react(chatId, _messageId, emoji) {
      const wanted = plain(emoji)
      const sticker = Object.entries(deps.config.stickers).find(([key]) => plain(key) === wanted)?.[1]
      if (sticker === undefined) {
        const sent = await deps.api.sendMessage(chatId, wanted)
        return posted('fallback', sent.messageId, wanted)
      }
      const sent = await deps.api.sendSticker(chatId, sticker)
      return posted('fallback', sent.messageId, `[sticker ${wanted}]`)
    },
  }
}
