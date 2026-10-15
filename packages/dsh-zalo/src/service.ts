import type { Dispatcher } from './bot.ts'
import type { ChatLog, ChatLogEntry } from './chatlog.ts'
import type { ZaloApi } from './zalo-api.ts'

/** The running bot, for extension plugins; provided only while the bot polls. */
export interface ZaloService {
  readonly api: ZaloApi
  readonly chatLog: ChatLog
  /** Per-chat queue shared with message handling; tasks of one chat never overlap. */
  readonly queue: Pick<Dispatcher, 'enqueue' | 'isBusy'>
  readonly bot: { readonly id: string; readonly accountName: string }
  /** Where plugins keep their own durable files. */
  readonly dataDir: string
  /** Chat whose live agent has this id; undefined for subagents and unknown sessions. */
  chatOf(agentId: string): string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    zalo: ZaloService
  }
  interface Events {
    /** A message in this chat passed the gate and is about to get a turn. */
    'zalo/turn'(chatId: string): void
    /** A line was appended to a chat's log (human or bot), after it was written. */
    'zalo/message'(chatId: string, entry: ChatLogEntry): void
  }
}
