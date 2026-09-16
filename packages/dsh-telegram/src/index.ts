import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { assertConfig, Config } from './config.ts'

export { Config } from './config.ts'
export type { Config as TelegramConfig } from './config.ts'

/** Cordis plugin name. */
export const name = 'dsh-telegram'
/** Services required before the bot starts. */
export const inject = ['agents', 'tools', 'attachments', 'loader']

export function apply(ctx: Context, config: Config): void {
  assertConfig(config)
  const probe = createUserMessage({ content: [{ type: 'text', text: 'probe' }], source: { kind: 'user' } })
  ctx.logger.info(`dsh-telegram loaded (allowFrom=${config.allowFrom.length}, probe=${probe.role})`)
}
