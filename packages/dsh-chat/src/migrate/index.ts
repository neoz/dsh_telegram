import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { migrate, type MigrateOptions } from './migrate.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatData: ChatData
  }
}

/** Paths every chat plugin shares; provided once the data layout is current. */
export interface ChatData {
  readonly dataDir: string
  readonly workspaceRoot: string
}

export const Config: z<MigrateOptions> = z.object({
  dataDir: z.string().required(),
  workspaceRoot: z.string().required(),
  legacyChannel: z.string(),
})

/** Cordis plugin name. */
export const name = 'dsh-chat-migrate'

/** Checks Schemastery cannot express; throws on the first violation. */
export function assertConfig(config: MigrateOptions): void {
  for (const key of ['workspaceRoot', 'dataDir'] as const) {
    if (!config[key].startsWith('/') && !/^[A-Za-z]:[\\/]/.test(config[key])) throw new Error(`dsh-chat: ${key} must be an absolute path`)
  }
  if (config.legacyChannel !== undefined && !/^[a-z]+$/.test(config.legacyChannel)) throw new Error('dsh-chat: legacyChannel must be lowercase letters')
}

export function apply(ctx: Context, config: MigrateOptions): void {
  assertConfig(config)
  const logger = ctx.logger('dsh-chat')
  ctx.effect(() => {
    let stopped = false
    let revoke: (() => void) | undefined
    migrate(config).then((result) => {
      if (result === 'migrated') logger.info(`dsh-chat: data layout migrated${config.legacyChannel === undefined ? '' : ` from the ${config.legacyChannel} layout`}`)
      if (!stopped) revoke = ctx.provide('chatData', { dataDir: config.dataDir, workspaceRoot: config.workspaceRoot })
    }, (error: unknown) => {
      logger.error(`dsh-chat: data migration failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}; chat plugins stay stopped until it succeeds on a restart`)
    })
    return () => {
      stopped = true
      revoke?.()
    }
  }, 'dsh-chat: data layout')
}
