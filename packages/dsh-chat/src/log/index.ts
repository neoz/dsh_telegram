import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ChatKey } from '../keys.ts'
import type {} from '../migrate/index.ts'
import { ChatLog, type ChatLogEntry } from './chatlog.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatLog: ChatLog
  }
  interface Events {
    /** A line was appended to a chat's log (human or bot), after it was written. */
    'chat/message'(key: ChatKey, entry: ChatLogEntry): void
  }
}

export interface LogConfig {
  /** Each chat log keeps its newest entries up to this many; older ones are dropped. */
  readonly maxEntries: number
}

export const Config: z<LogConfig> = z.object({
  maxEntries: z.number().min(1).default(15_000),
})

/** Cordis plugin name. */
export const name = 'dsh-chat-log'
export const inject = ['chatData']

/** Chat-log listener that forwards lines as an event; Cordis does not isolate listeners, so a throw only warns. */
export function forwardAppends(emit: (key: ChatKey, entry: ChatLogEntry) => void, warn: (msg: string) => void): (key: ChatKey, entry: ChatLogEntry) => void {
  return (key, entry) => {
    try {
      emit(key, entry)
    } catch (error) {
      warn(`dsh-chat: a chat/message listener failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function apply(ctx: Context, config: LogConfig): void {
  const logger = ctx.logger('dsh-chat')
  const log = new ChatLog(ctx.chatData.dataDir, forwardAppends((key, entry) => ctx.emit('chat/message', key, entry), msg => logger.warn(msg)), config.maxEntries)
  ctx.effect(() => ctx.provide('chatLog', log), 'dsh-chat: chatLog')
}
