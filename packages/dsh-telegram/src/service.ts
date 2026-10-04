import type { Dispatcher, PromptInput } from './bot.ts'
import type { ChatLog } from './chatlog.ts'
import type { TurnContext } from './sessions.ts'
import type { TelegramApi } from './telegram-api.ts'

/** The running bot, shared with extension plugins such as `dsh-telegram/idle`; provided only while the bot polls. */
export interface TelegramService {
  readonly api: TelegramApi
  readonly chatLog: ChatLog
  /** Per-chat queue shared with message handling; tasks of one chat never overlap. */
  readonly queue: Pick<Dispatcher, 'enqueue' | 'isBusy'>
  readonly bot: { readonly id: number; readonly username: string }
  readonly selection: { readonly provider: string; readonly model: string }
  /** Where plugins keep their own durable files. */
  readonly dataDir: string
  readonly superAdmins: readonly number[]
  /** Chat whose live agent has this id; undefined for subagents and unknown sessions. */
  chatOf(agentId: string): number | undefined
  /** Sender of the running turn in that chat. */
  turnOf(chatId: number): TurnContext | undefined
  /** Queues an agent turn in the chat as if `sender` had written `text`; the reply quotes no message. */
  prompt(chatId: number, input: PromptInput): void
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
