import { GrammyError, HttpError, InputFile, type Bot } from 'grammy'

export interface ReplyTarget { readonly messageId: number }
export interface SendTextOptions { readonly parseMode?: 'HTML'; readonly replyTo?: ReplyTarget }
export interface SendFileOptions {
  readonly caption?: string
  readonly parseMode?: 'HTML'
  readonly replyTo?: ReplyTarget
  readonly filename?: string
}

/** The Bot API surface the plugin needs; tests substitute a recorder. */
export interface TelegramApi {
  sendMessage(chatId: number, text: string, options?: SendTextOptions): Promise<{ messageId: number }>
  editMessageText(chatId: number, messageId: number, text: string, options?: { parseMode?: 'HTML' }): Promise<void>
  deleteMessage(chatId: number, messageId: number): Promise<void>
  sendChatAction(chatId: number, action: 'typing'): Promise<void>
  setReaction(chatId: number, messageId: number, emoji: string): Promise<void>
  sendDocument(chatId: number, data: Buffer, options: SendFileOptions & { filename: string }): Promise<{ messageId: number }>
  sendPhoto(chatId: number, data: Buffer, options?: SendFileOptions): Promise<{ messageId: number }>
  downloadFile(fileId: string): Promise<{ data: Buffer; filePath: string }>
}

export class TelegramApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'TelegramApiError'
  }
}

function replyParameters(target: ReplyTarget | undefined) {
  return target === undefined ? {} : { reply_parameters: { message_id: target.messageId, allow_sending_without_reply: true } }
}

async function wrap<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof GrammyError) throw new TelegramApiError(error.description, error.error_code)
    if (error instanceof HttpError) throw new TelegramApiError(error.message)
    throw error
  }
}

export function createGrammyApi(bot: Bot, token: string): TelegramApi {
  const api = bot.api
  return {
    sendMessage: (chatId, text, options = {}) => wrap(async () => {
      const sent = await api.sendMessage(chatId, text, {
        ...(options.parseMode === undefined ? {} : { parse_mode: options.parseMode }),
        ...replyParameters(options.replyTo),
        link_preview_options: { is_disabled: true },
      })
      return { messageId: sent.message_id }
    }),
    editMessageText: (chatId, messageId, text, options = {}) => wrap(async () => {
      await api.editMessageText(chatId, messageId, text, {
        ...(options.parseMode === undefined ? {} : { parse_mode: options.parseMode }),
        link_preview_options: { is_disabled: true },
      })
    }),
    deleteMessage: (chatId, messageId) => wrap(async () => { await api.deleteMessage(chatId, messageId) }),
    sendChatAction: (chatId, action) => wrap(async () => { await api.sendChatAction(chatId, action) }),
    setReaction: (chatId, messageId, emoji) => wrap(async () => {
      await api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: emoji as never }])
    }),
    sendDocument: (chatId, data, options) => wrap(async () => {
      const sent = await api.sendDocument(chatId, new InputFile(data, options.filename), {
        ...(options.caption === undefined ? {} : { caption: options.caption }),
        ...(options.parseMode === undefined ? {} : { parse_mode: options.parseMode }),
        ...replyParameters(options.replyTo),
      })
      return { messageId: sent.message_id }
    }),
    sendPhoto: (chatId, data, options = {}) => wrap(async () => {
      const sent = await api.sendPhoto(chatId, new InputFile(data, options.filename), {
        ...(options.caption === undefined ? {} : { caption: options.caption }),
        ...(options.parseMode === undefined ? {} : { parse_mode: options.parseMode }),
        ...replyParameters(options.replyTo),
      })
      return { messageId: sent.message_id }
    }),
    downloadFile: fileId => wrap(async () => {
      const file = await api.getFile(fileId)
      if (file.file_path === undefined) throw new TelegramApiError(`file ${fileId} has no file_path`)
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`)
      if (!response.ok) throw new TelegramApiError(`download failed: ${response.status}`, response.status)
      return { data: Buffer.from(await response.arrayBuffer()), filePath: file.file_path }
    }),
  }
}
