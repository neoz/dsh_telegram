import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { nextDueAt } from './domain.ts'
import { startScheduler } from './delivery.ts'
import { ReminderBook } from './store.ts'
import { createScheduleTools } from './tools.ts'
import type {} from '../log/index.ts'
import type {} from '../migrate/index.ts'
import type {} from '../router/plugin.ts'

export interface ScheduleConfig {
  /** Zone for daily, weekly and cron rules that name none. */
  readonly timeZone: string
  readonly maxPerChat: number
}

export const Config: z<ScheduleConfig> = z.object({
  timeZone: z.string().default('Asia/Ho_Chi_Minh'),
  maxPerChat: z.number().min(1).default(20),
})

/** Checks Schemastery cannot express; throws on the first violation. */
export function assertScheduleConfig(config: ScheduleConfig): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone })
  } catch {
    throw new Error(`dsh-chat: schedule.timeZone must be an IANA time zone, got ${config.timeZone}`)
  }
}

/** Cordis plugin name. */
export const name = 'dsh-chat-schedule'

/**
 * Injects nothing itself, so Cordis validates the config at load even when the bot never starts;
 * the reminder files, timer and tools live while the router provides `chat`.
 */
export function apply(ctx: Context, config: ScheduleConfig): void {
  assertScheduleConfig(config)
  ctx.inject(['chat', 'chatData', 'chatLog', 'tools'], (ctx) => {
    const logger = ctx.logger('dsh-chat')
    const log = { info: (msg: string) => logger.info(msg), warn: (msg: string) => logger.warn(msg) }
    const book = new ReminderBook(ctx.chatData.dataDir)
    // A corrupted file throws here: this fiber fails and the file stays as it was.
    book.load()
    const reminders = book.all()
    const next = nextDueAt(reminders)
    log.info(`dsh-chat: reminders on (${reminders.length} active${next === undefined ? '' : `, next ${new Date(next).toISOString()}`})`)
    const scheduler = startScheduler({ book, chat: ctx.chat, chatLog: ctx.chatLog, log })
    ctx.effect(() => () => {
      scheduler.stop()
      book.close()
    }, 'dsh-chat: reminder timer')
    const tools = createScheduleTools({
      chat: ctx.chat, book, timeZone: config.timeZone, maxPerChat: config.maxPerChat, changed: scheduler.changed,
    })
    for (const tool of tools) ctx.effect(() => ctx.tools.register(tool), `dsh-chat: ${tool.name}`)
  })
}
