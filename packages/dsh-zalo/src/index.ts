import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-tools'
import { idIn } from 'dsh-chat'
import type {} from 'dsh-chat/log'
import type {} from 'dsh-chat/memory'
import type {} from 'dsh-chat/migrate'
import type {} from 'dsh-chat/sessions'
import { createDispatcher, type Dispatcher } from './bot.ts'
import { assertConfig, Config } from './config.ts'
import { SeenIds, startPolling, type Poller } from './poller.ts'
import type { ZaloService } from './service.ts'
import { createZaloApi } from './zalo-api.ts'

export { Config } from './config.ts'
export type { Config as ZaloConfig } from './config.ts'
export type { ZaloService } from './service.ts'

/** Cordis plugin name. */
export const name = 'dsh-zalo'
/** Services required before the bot starts; the stores come from the dsh-chat plugins. */
export const inject = ['attachments', 'loader', 'chatData', 'chatLog', 'chatMemory', 'chatAgents']

interface Started { poller: Poller; dispatcher: Dispatcher; service: ZaloService }

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

  const chatLog = ctx.chatLog
  const agents = ctx.chatAgents

  const dispatcher = createDispatcher({
    api,
    config,
    chatLog,
    memory: ctx.chatMemory,
    agents,
    attachments: ctx.attachments,
    bot: me,
    log,
    noteTurn: chatId => ctx.emit('zalo/turn', chatId),
    strangers: new SeenIds(1000),
  })
  const poller = startPolling({
    api,
    timeoutSec: config.pollTimeoutSec,
    onUpdate: update => dispatcher.dispatch(update),
    backoff: { startDelayMs: config.retry.startDelayMs, maxDelayMs: config.retry.maxDelayMs },
    log,
  })
  log.info(`dsh-zalo: polling as ${me.accountName}`)
  return {
    poller,
    dispatcher,
    service: {
      api,
      chatLog,
      queue: dispatcher,
      bot: me,
      dataDir: join(ctx.chatData.dataDir, 'zalo'),
      chatOf: (agentId) => {
        const key = agents.chatOf(agentId)
        return key === undefined ? undefined : idIn('zalo', key)
      },
    },
  }
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
  assertConfig(config)
  const log = loggerFor(ctx)
  // Extension plugins listen to zalo/message until they move to dsh-chat.
  ctx.on('chat/message', (key, entry) => {
    const id = idIn('zalo', key)
    if (id !== undefined) ctx.emit('zalo/message', id, entry)
  })
  let started: Started | undefined
  let revoke: (() => void) | undefined
  let stopped = false
  ctx.effect(() => {
    const cancel = retryStart(() => start(ctx, config), (result) => {
      if (stopped) {
        result.dispatcher.close()
        void result.poller.stop()
        return
      }
      started = result
      // Provided only now: Cordis starts dependants as soon as a name is provided, with or without a value.
      revoke = ctx.provide('zalo', result.service)
    }, (error, delayMs) => {
      log.error(`dsh-zalo: failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}; retrying in ${delayMs}ms`)
    }, STARTUP_BACKOFF)
    return () => {
      stopped = true
      cancel()
      if (started === undefined) return
      const { poller, dispatcher } = started
      started = undefined
      // Dependants stop first, while the bot can still serve their last calls.
      revoke?.()
      revoke = undefined
      // Queued messages must not start turns on a bot that is going away.
      dispatcher.close()
      void poller.stop()
    }
  }, 'dsh-zalo: bot runner')
}
