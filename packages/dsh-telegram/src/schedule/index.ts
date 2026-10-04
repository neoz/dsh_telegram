import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { nextDueAt } from './domain.ts'
import { startScheduler } from './delivery.ts'
import { ReminderStore } from './store.ts'
import { createScheduleTools } from './tools.ts'
import type {} from '../service.ts'

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
    throw new Error(`dsh-telegram: schedule.timeZone must be an IANA time zone, got ${config.timeZone}`)
  }
}

/** Cordis plugin name. */
export const name = 'dsh-telegram-schedule'

/**
 * Injects nothing itself, so Cordis validates the config at load even when the bot never starts;
 * the store, timer and tools live while the bot provides `telegram`.
 */
export function apply(ctx: Context, config: ScheduleConfig): void {
  assertScheduleConfig(config)
  ctx.inject(['telegram', 'tools'], (ctx) => {
    const logger = ctx.logger('dsh-telegram')
    const log = { info: (msg: string) => logger.info(msg), warn: (msg: string) => logger.warn(msg) }
    const store = new ReminderStore(join(ctx.telegram.dataDir, 'schedule.json'))
    // A corrupted file throws here: this fiber fails and the file stays as it was.
    store.load()
    const reminders = store.all()
    const next = nextDueAt(reminders)
    log.info(`dsh-telegram: reminders on (${reminders.length} active${next === undefined ? '' : `, next ${new Date(next).toISOString()}`})`)
    const scheduler = startScheduler({ store, telegram: ctx.telegram, log })
    ctx.effect(() => () => {
      scheduler.stop()
      store.close()
    }, 'dsh-telegram: reminder timer')
    const tools = createScheduleTools({
      telegram: ctx.telegram, store, timeZone: config.timeZone, maxPerChat: config.maxPerChat, changed: scheduler.changed,
    })
    for (const tool of tools) ctx.effect(() => ctx.tools.register(tool), `dsh-telegram: ${tool.name}`)
  })
}
