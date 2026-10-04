import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { startIdle } from './idle.ts'
import type {} from './service.ts'

/** Unprompted engagement in active groups; see the idle engagement spec. */
export interface IdleConfig {
  readonly enabled: boolean
  readonly chatIds: number[]
  readonly idleMinutes: number
  readonly minNewMessages: number
  readonly chance: number
  readonly checkIntervalMinutes: number
  readonly maxPerDay: number
  readonly quietHours: { readonly from: number; readonly to: number }
  readonly timezone: string
  readonly contextMessages: number
  readonly persona: string
}

const DEFAULT_IDLE: IdleConfig = {
  enabled: false,
  chatIds: [],
  idleMinutes: 60,
  minNewMessages: 5,
  chance: 0.3,
  checkIntervalMinutes: 10,
  maxPerDay: 5,
  quietHours: { from: 23, to: 7 },
  timezone: 'Asia/Ho_Chi_Minh',
  contextMessages: 20,
  persona: '',
}

export const Config: z<IdleConfig> = z.object({
  enabled: z.boolean().default(DEFAULT_IDLE.enabled),
  chatIds: z.array(z.number()).default([]),
  idleMinutes: z.number().min(1).default(DEFAULT_IDLE.idleMinutes),
  minNewMessages: z.number().min(1).default(DEFAULT_IDLE.minNewMessages),
  chance: z.number().min(0).max(1).default(DEFAULT_IDLE.chance),
  checkIntervalMinutes: z.number().min(1).default(DEFAULT_IDLE.checkIntervalMinutes),
  maxPerDay: z.number().min(1).default(DEFAULT_IDLE.maxPerDay),
  quietHours: z.object({
    from: z.number().min(0).max(23).default(DEFAULT_IDLE.quietHours.from),
    to: z.number().min(0).max(23).default(DEFAULT_IDLE.quietHours.to),
  }).default(DEFAULT_IDLE.quietHours),
  timezone: z.string().default(DEFAULT_IDLE.timezone),
  contextMessages: z.number().min(1).default(DEFAULT_IDLE.contextMessages),
  persona: z.string().default(DEFAULT_IDLE.persona),
})

/** Checks Schemastery cannot express; throws on the first violation. */
export function assertIdleConfig(config: IdleConfig): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timezone })
  } catch {
    throw new Error(`dsh-telegram: idle.timezone must be an IANA time zone, got ${config.timezone}`)
  }
}

/** Cordis plugin name. */
export const name = 'dsh-telegram-idle'
/**
 * Injects nothing itself, so Cordis validates the config at load even when the bot never starts;
 * the scheduler runs while the bot provides `telegram` and is disposed when it revokes it.
 */
export function apply(ctx: Context, config: IdleConfig): void {
  assertIdleConfig(config)
  if (!config.enabled) return
  ctx.inject(['telegram', 'llm'], (ctx) => {
    const logger = ctx.logger('dsh-telegram')
    const { api, chatLog, queue, bot, selection } = ctx.telegram
    const handle = startIdle({
      config,
      provider: selection.provider,
      model: selection.model,
      llm: ctx.llm,
      api,
      chatLog,
      queue,
      botId: bot.id,
      botUsername: bot.username,
      log: { info: msg => logger.info(msg), warn: msg => logger.warn(msg) },
    })
    ctx.on('telegram/turn', chatId => handle.noteTurn(chatId))
    ctx.effect(() => () => handle.stop(), 'dsh-telegram: idle scheduler')
  })
}
