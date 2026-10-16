import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { autoRetry } from '@grammyjs/auto-retry'
import { run, type RunnerHandle } from '@grammyjs/runner'
import { chatKey, idIn } from 'dsh-chat'
import type {} from 'dsh-chat/log'
import type {} from 'dsh-chat/migrate'
import type {} from 'dsh-chat/sessions'
import { Bot } from 'grammy'
import { createTelegramChannel } from './channel.ts'
import { Config } from './config.ts'
import { toInbound, type TelegramMessage } from './inbound.ts'
import { telegramTurn, type TelegramService } from './service.ts'
import { createGrammyApi, type TelegramApi } from './telegram-api.ts'
import { createSendFileTool } from './tools.ts'

export { Config } from './config.ts'
export type { Config as TelegramConfig } from './config.ts'
export type { TelegramService } from './service.ts'

/** Cordis plugin name. */
export const name = 'dsh-telegram'
/** The router and stores come from the dsh-chat plugins. */
export const inject = ['loader', 'chatData', 'chatLog', 'chatAgents', 'chat']

interface Started { polling: Polling; api: TelegramApi; unregister: () => void; service: TelegramService }

const telegramIds = (keys: readonly string[]) => keys.flatMap((key) => {
  const id = idIn('telegram', key)
  return id === undefined ? [] : [Number(id)]
})

/** Narrow the Cordis logger to the three methods the modules take. */
function loggerFor(ctx: Context) {
  const logger = ctx.logger('dsh-telegram')
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

  const bot = new Bot(config.botToken)
  bot.api.config.use(autoRetry({
    maxRetryAttempts: config.retry.maxAttempts,
    maxDelaySeconds: config.retry.maxDelayMs / 1000,
  }))
  await bot.init()
  const api = createGrammyApi(bot, config.botToken, config.retry)
  const agents = ctx.chatAgents
  const workspaceOf = (chatId: number) => agents.workspaceFor(chatKey('telegram', chatId))
  const botId = bot.botInfo.id
  const botUsername = bot.botInfo.username

  // Registered before polling starts, so the first update never finds the channel offline.
  const unregister = ctx.chat.register(createTelegramChannel({
    api, bot: { id: botId, username: botUsername }, config, log,
    outboxFor: chatId => join(workspaceOf(chatId), 'outbox'),
  }))
  bot.on('message', (update) => {
    const inbound = toInbound(update.message as unknown as TelegramMessage, {
      api, botId, botUsername, log, inboxFor: chatId => join(workspaceOf(chatId), 'inbox'),
    })
    if (inbound !== undefined) ctx.chat.inbound(inbound)
  })
  bot.catch((error) => { log.error(`dsh-telegram: update handler failed: ${String(error.error)}`) })

  const polling = startPolling(bot, config, log)
  log.info(`dsh-telegram: polling as @${botUsername}`)
  const key = (chatId: number) => chatKey('telegram', chatId)
  return {
    polling,
    api,
    unregister,
    service: {
      api,
      chatLog: ctx.chatLog,
      queue: { enqueue: (chatId, task) => ctx.chat.enqueue(key(chatId), task), isBusy: chatId => ctx.chat.isBusy(key(chatId)) },
      bot: { id: botId, username: botUsername },
      selection: agents.selection,
      dataDir: join(ctx.chatData.dataDir, 'telegram'),
      superAdmins: telegramIds(ctx.chat.superAdmins),
      chatOf: (agentId) => {
        const found = ctx.chat.chatOf(agentId)
        const id = found === undefined ? undefined : idIn('telegram', found)
        return id === undefined ? undefined : Number(id)
      },
      turnOf: chatId => telegramTurn(ctx.chat.turnOf(key(chatId))),
      prompt: (chatId, input) => ctx.chat.prompt(key(chatId), {
        text: input.text,
        sender: { id: String(input.sender.id), name: input.sender.first_name, ...(input.sender.username === undefined ? {} : { username: input.sender.username }) },
        isGroup: chatId < 0,
      }),
    },
  }
}

interface Polling { stop(): Promise<void> }

/**
 * Run the grammY runner and restart it after a polling failure. A failure that
 * outlives the runner's own retry window (or a 409 from an overlapping instance)
 * must neither take the dsh process down nor leave the bot silently dead.
 */
function startPolling(bot: Bot, config: Config, log: ReturnType<typeof loggerFor>): Polling {
  let stopped = false
  let runner: RunnerHandle | undefined
  let restartTimer: NodeJS.Timeout | undefined
  const launch = (): void => {
    if (stopped) return
    runner = run(bot, { runner: { maxRetryTime: config.pollRetryMs, retryInterval: 'exponential' } })
    runner.task()?.catch((error: unknown) => {
      if (stopped) return
      log.error(`dsh-telegram: polling stopped (${error instanceof Error ? error.message : String(error)}); restarting in ${config.retry.maxDelayMs}ms`)
      restartTimer = setTimeout(launch, config.retry.maxDelayMs)
    })
  }
  launch()
  return {
    async stop() {
      stopped = true
      if (restartTimer !== undefined) clearTimeout(restartTimer)
      if (runner?.isRunning()) await runner.stop()
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
  const log = loggerFor(ctx)
  let started: Started | undefined
  let revoke: (() => void) | undefined
  let stopped = false
  ctx.on('chat/agent', (agentCtx, key) => {
    const id = idIn('telegram', key)
    if (id === undefined) return
    const tool = createSendFileTool({ api: () => started?.api, chatId: Number(id), workspaceDir: ctx.chatAgents.workspaceFor(key), maxUploadBytes: config.retry.maxUploadMb * 1024 * 1024 })
    agentCtx.effect(() => agentCtx.tools.register(tool), 'dsh-telegram: telegram_send_file')
  })
  // Idle engagement listens to telegram/* with numeric chat ids until it moves to dsh-chat.
  ctx.on('chat/message', (key, entry) => {
    const id = idIn('telegram', key)
    if (id !== undefined) ctx.emit('telegram/message', Number(id), entry)
  })
  ctx.on('chat/turn', (key) => {
    const id = idIn('telegram', key)
    if (id !== undefined) ctx.emit('telegram/turn', Number(id))
  })
  ctx.effect(() => {
    const cancel = retryStart(() => start(ctx, config), (result) => {
      if (stopped) {
        result.unregister()
        void result.polling.stop()
        return
      }
      started = result
      // Provided only now: Cordis starts dependants as soon as a name is provided, with or without a value.
      revoke = ctx.provide('telegram', result.service)
    }, (error, delayMs) => {
      log.error(`dsh-telegram: failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}; retrying in ${delayMs}ms`)
    }, STARTUP_BACKOFF)
    return () => {
      stopped = true
      cancel()
      if (started === undefined) return
      const { polling, unregister } = started
      started = undefined
      // Dependants stop first, while the bot can still serve their last calls; queued turns are then skipped.
      revoke?.()
      revoke = undefined
      unregister()
      return polling.stop()
    }
  }, 'dsh-telegram: bot runner')
}
