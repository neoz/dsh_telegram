import type { Dispatcher } from './bot.ts'
import type { ChatLog } from './chatlog.ts'
import type { TelegramApi } from './telegram-api.ts'

/** The running bot, shared with extension plugins such as `dsh-telegram/idle`; provided only while the bot polls. */
export interface TelegramService {
  readonly api: TelegramApi
  readonly chatLog: ChatLog
  /** Per-chat queue shared with message handling; tasks of one chat never overlap. */
  readonly queue: Pick<Dispatcher, 'enqueue' | 'isBusy'>
  readonly bot: { readonly id: number; readonly username: string }
  readonly selection: { readonly provider: string; readonly model: string }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    telegram: TelegramService
  }
  interface Events {
    /** A message in this chat passed the gate and is about to get a turn. */
    'telegram/turn'(chatId: number): void
  }
}
