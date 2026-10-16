import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import { chatKey } from 'dsh-chat'
import type {} from 'dsh-chat/sessions'
import { createZaloChannel } from './channel.ts'
import { Config } from './config.ts'
import { toInbound } from './inbound.ts'
import { startPolling, type Poller } from './poller.ts'
import { createZaloApi } from './zalo-api.ts'

export { Config } from './config.ts'
export type { Config as ZaloConfig } from './config.ts'

/** Cordis plugin name. */
export const name = 'dsh-zalo'
/** The router and stores come from the dsh-chat plugins. */
export const inject = ['loader', 'chatAgents', 'chat']

interface Started { poller: Poller; unregister: () => void }

/** Narrow the Cordis logger to the three methods the modules take. */
function loggerFor(ctx: Context) {
  const logger = ctx.logger('dsh-zalo')
  return {
    info: (msg: string) => logger.info(msg),
    warn: (msg: string) => logger.warn(msg),
    error: (msg: string) => logger.error(msg),
  }
}

async function start(ctx: Context, config: Config): Promise<Started> {
  const log = loggerFor(ctx)
  // Wait for the complete application so agent-scoped tools and adapters are composed.
  await ctx.get('loader')?.await()

  const api = createZaloApi(config.botToken, config.retry, fetch, config.maxDownloadMb * 1024 * 1024)
  const me = await api.getMe()
  // Registered before polling starts, so the first update never finds the channel offline.
  const unregister = ctx.chat.register(createZaloChannel({ api, bot: me, config, log }))
  const trigger = { accountName: me.accountName, ...(me.displayName === undefined ? {} : { displayName: me.displayName }), groupPrefix: config.groupPrefix }
  const poller = startPolling({
    api,
    timeoutSec: config.pollTimeoutSec,
    onUpdate: (update) => {
      const inbound = toInbound(update, {
        ...trigger, api, botId: me.id, log,
        inboxFor: chatId => join(ctx.chatAgents.workspaceFor(chatKey('zalo', chatId)), 'inbox'),
      })
      if (inbound !== undefined) ctx.chat.inbound(inbound)
    },
    backoff: { startDelayMs: config.retry.startDelayMs, maxDelayMs: config.retry.maxDelayMs },
    log,
  })
  log.info(`dsh-zalo: polling as ${me.accountName}`)
  return { poller, unregister }
}

/**
 * Call `start` until it resolves, doubling the delay after each failure up to `maxDelayMs`.
 * A failed boot (network down, a bad state file) must not leave the process up with no bot.
 * Returns a cancel that stops further attempts.
 */
export function retryStart<T>(
  start: () => Promise<T>,
  onStarted: (result: T) => void,
  onError: (error: unknown, delayMs: number) => void,
  backoff: { startDelayMs: number; maxDelayMs: number },
): () => void {
  let cancelled = false
  let timer: NodeJS.Timeout | undefined
  const attempt = (failures: number): void => {
    start().then(onStarted, (error: unknown) => {
      if (cancelled) return
      const delayMs = Math.min(backoff.startDelayMs * 2 ** failures, backoff.maxDelayMs)
      onError(error, delayMs)
      timer = setTimeout(() => attempt(failures + 1), delayMs)
    })
  }
  attempt(0)
  return () => {
    cancelled = true
    if (timer !== undefined) clearTimeout(timer)
  }
}

const STARTUP_BACKOFF = { startDelayMs: 5_000, maxDelayMs: 300_000 }

export function apply(ctx: Context, config: Config): void {
  const log = loggerFor(ctx)
  let started: Started | undefined
  let stopped = false
  ctx.effect(() => {
    const cancel = retryStart(() => start(ctx, config), (result) => {
      if (stopped) {
        result.unregister()
        void result.poller.stop()
        return
      }
      started = result
    }, (error, delayMs) => {
      log.error(`dsh-zalo: failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}; retrying in ${delayMs}ms`)
    }, STARTUP_BACKOFF)
    return () => {
      stopped = true
      cancel()
      if (started === undefined) return
      const { poller, unregister } = started
      started = undefined
      // Queued messages must not start turns on a bot that is going away.
      unregister()
      return poller.stop()
    }
  }, 'dsh-zalo: bot runner')
}
