import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '../migrate/index.ts'
import { sweepOldFiles } from './sweep.ts'

export interface RetentionConfig {
  /** Inbox and outbox files untouched for this many days are deleted. */
  readonly fileRetentionDays: number
}

export const Config: z<RetentionConfig> = z.object({
  fileRetentionDays: z.number().min(1).default(90),
})

/** Cordis plugin name. */
export const name = 'dsh-chat-retention'
export const inject = ['chatData']

const DAY_MS = 86_400_000

/** Sweeps old inbox and outbox files now and then once a day. */
export function apply(ctx: Context, config: RetentionConfig): void {
  const logger = ctx.logger('dsh-chat')
  ctx.effect(() => {
    const sweep = () => {
      sweepOldFiles(ctx.chatData.workspaceRoot, config.fileRetentionDays * DAY_MS).catch((error: unknown) => {
        logger.warn(`dsh-chat: file retention sweep failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    sweep()
    const timer = setInterval(sweep, DAY_MS).unref()
    return () => clearInterval(timer)
  }, 'dsh-chat: file retention')
}
