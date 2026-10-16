import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-tools'
import { autoRetry } from '@grammyjs/auto-retry'
import { run, type RunnerHandle } from '@grammyjs/runner'
import { chatKey, idIn } from 'dsh-chat'
import type {} from 'dsh-chat/log'
import type {} from 'dsh-chat/memory'
import type {} from 'dsh-chat/migrate'
import type {} from 'dsh-chat/sessions'
import { Bot } from 'grammy'
import { createDispatcher } from './bot.ts'
import { assertConfig, Config } from './config.ts'
import type { TelegramMessage } from './inbound.ts'
import { telegramTurn, type TelegramService } from './service.ts'
import { createGrammyApi, type TelegramApi } from './telegram-api.ts'
import { createSendFileTool } from './tools.ts'
import type { SessionEventFeed } from './turn.ts'

export { Config } from './config.ts'
export type { Config as TelegramConfig } from './config.ts'
export type { TelegramService } from './service.ts'

/** Cordis plugin name. */
export const name = 'dsh-telegram'
/** Services required before the bot starts; the stores come from the dsh-chat plugins. */
export const inject = ['attachments', 'loader', 'chatData', 'chatLog', 'chatMemory', 'chatAgents']

interface Started { polling: Polling; api: TelegramApi; service: TelegramService }

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

  const chatLog = ctx.chatLog
  const agents = ctx.chatAgents
  const feed: SessionEventFeed = listener => ctx.on('session/event', (session, event) => listener(String(session.id), event))

  const dispatcher = createDispatcher({
    api,
    config,
    chatLog,
    memory: ctx.chatMemory,
    agents,
    feed,
    attachments: ctx.attachments,
    botId: bot.botInfo.id,
    botUsername: bot.botInfo.username,
    log,
    noteTurn: chatId => ctx.emit('telegram/turn', chatId),
  })
  bot.on('message', (update) => { dispatcher.dispatch(update.message as unknown as TelegramMessage) })
  bot.catch((error) => { log.error(`dsh-telegram: update handler failed: ${String(error.error)}`) })

  const polling = startPolling(bot, config, log)
  log.info(`dsh-telegram: polling as @${bot.botInfo.username}`)
  return {
    polling,
    api,
    service: {
      api,
      chatLog,
      queue: dispatcher,
      bot: { id: bot.botInfo.id, username: bot.botInfo.username },
      selection: agents.selection,
      dataDir: join(ctx.chatData.dataDir, 'telegram'),
      superAdmins: config.superAdmins,
      chatOf: (agentId) => {
        const key = agents.chatOf(agentId)
        const id = key === undefined ? undefined : idIn('telegram', key)
        return id === undefined ? undefined : Number(id)
      },
      turnOf: chatId => telegramTurn(agents.turnOf(chatKey('telegram', chatId))),
      prompt: (chatId, input) => dispatcher.prompt(chatId, input),
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
  assertConfig(config)
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
  // Idle engagement listens to telegram/message with numeric chat ids until it moves to dsh-chat.
  ctx.on('chat/message', (key, entry) => {
    const id = idIn('telegram', key)
    if (id !== undefined) ctx.emit('telegram/message', Number(id), entry)
  })
  ctx.effect(() => {
    const cancel = retryStart(() => start(ctx, config), (result) => {
      if (stopped) {
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
      const { polling } = started
      started = undefined
      // Dependants stop first, while the bot can still serve their last calls.
      revoke?.()
      revoke = undefined
      return polling.stop()
    }
  }, 'dsh-telegram: bot runner')
}
