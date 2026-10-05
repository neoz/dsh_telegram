import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { startIdle, type IdleEvent } from './scheduler.ts'
import type {} from '../service.ts'

/** Unprompted engagement in active groups; see the idle engagement spec. */
export interface IdleConfig {
  readonly enabled: boolean
  readonly chatIds: number[]
  /** The bot is idle once nobody has addressed it for this long. */
  readonly idleMinutes: number
  readonly minNewMessages: number
  readonly chance: number
  /** Window for a hot burst and for messages the bot may pick. */
  readonly hotWindowMinutes: number
  /** Human silence longer than this ends a burst. */
  readonly burstGapMinutes: number
  /** Engagements allowed per burst; each slot rolls `chance` once. */
  readonly maxPerBurst: number
  /** Minimum gap between two slots of a burst, whether the earlier one engaged, missed or was skipped. */
  readonly slotGapMinutes: number
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
  hotWindowMinutes: 5,
  burstGapMinutes: 15,
  maxPerBurst: 1,
  slotGapMinutes: 5,
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
  hotWindowMinutes: z.number().min(1).default(DEFAULT_IDLE.hotWindowMinutes),
  burstGapMinutes: z.number().min(1).default(DEFAULT_IDLE.burstGapMinutes),
  maxPerBurst: z.number().min(1).default(DEFAULT_IDLE.maxPerBurst),
  slotGapMinutes: z.number().min(1).default(DEFAULT_IDLE.slotGapMinutes),
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
    const file = join(ctx.telegram.dataDir, 'idle-decisions.jsonl')
    // Appends run one after another so lines keep their order; a failed write only warns.
    let writing = Promise.resolve()
    const record = (event: IdleEvent): void => {
      writing = writing.then(() => appendFile(file, JSON.stringify(event) + '\n', 'utf8')).catch((error: unknown) => {
        logger.warn(`dsh-telegram: writing ${file} failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
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
      record,
    })
    ctx.on('telegram/turn', chatId => handle.noteTurn(chatId))
    ctx.on('telegram/message', (chatId, entry) => handle.observe(chatId, entry))
    ctx.effect(() => () => handle.stop(), 'dsh-telegram: idle scheduler')
  })
}
