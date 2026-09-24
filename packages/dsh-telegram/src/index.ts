import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-tools'
import { autoRetry } from '@grammyjs/auto-retry'
import { run, type RunnerHandle } from '@grammyjs/runner'
import { Bot } from 'grammy'
import { createDispatcher } from './bot.ts'
import { ChatLog } from './chatlog.ts'
import { assertConfig, Config } from './config.ts'
import type { TelegramMessage } from './inbound.ts'
import { MemoryStore } from './memory.ts'
import { sweepOldFiles } from './retention.ts'
import { SessionMap } from './session-map.ts'
import { ChatAgents } from './sessions.ts'
import { createGrammyApi } from './telegram-api.ts'
import { registerChatTools } from './tools.ts'
import type { SessionEventFeed } from './turn.ts'

export { Config } from './config.ts'
export type { Config as TelegramConfig } from './config.ts'

/** Cordis plugin name. */
export const name = 'dsh-telegram'
/** Services required before the bot starts. */
export const inject = ['agents', 'tools', 'attachments', 'loader']

interface Started { polling: Polling; agents: ChatAgents }

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
  const api = createGrammyApi(bot, config.botToken)

  const chatLog = new ChatLog(join(config.dataDir, 'chatlog'))
  const memory = new MemoryStore(join(config.dataDir, 'memory'), config.memory)
  const map = new SessionMap(join(config.dataDir, 'telegram-sessions.json'))
  await map.load()

  const feed: SessionEventFeed = listener => ctx.on('session/event', (session, event) => listener(String(session.id), event))
  const maxUploadBytes = config.retry.maxUploadMb * 1024 * 1024
  const agents: ChatAgents = new ChatAgents({
    agents: ctx.agents,
    map,
    workspaceRoot: config.workspaceRoot,
    selection: {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    },
    setup: (agentCtx, _agent, chatId) => {
      registerChatTools(agentCtx, {
        api, chatLog, chatId, workspaceDir: agents.workspaceFor(chatId), maxUploadBytes,
        memory, superAdmins: config.superAdmins, currentTurn: () => agents.turnOf(chatId),
      })
    },
    log,
  })

  const dispatch = createDispatcher({
    api,
    config,
    chatLog,
    memory,
    agents,
    feed,
    attachments: ctx.attachments,
    botId: bot.botInfo.id,
    botUsername: bot.botInfo.username,
    log,
  })
  bot.on('message', (update) => { dispatch(update.message as unknown as TelegramMessage) })
  bot.catch((error) => { log.error(`dsh-telegram: update handler failed: ${String(error.error)}`) })

  const polling = startPolling(bot, config, log)
  log.info(`dsh-telegram: polling as @${bot.botInfo.username}`)
  return { polling, agents }
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

const DAY_MS = 86_400_000

/** Sweeps old inbox and outbox files now and then once a day; returns the timer to clear on stop. */
function startRetention(config: Config, log: ReturnType<typeof loggerFor>): NodeJS.Timeout {
  const sweep = () => {
    sweepOldFiles(config.workspaceRoot, config.fileRetentionDays * DAY_MS).catch((error: unknown) => {
      log.warn(`dsh-telegram: file retention sweep failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  sweep()
  return setInterval(sweep, DAY_MS).unref()
}

export function apply(ctx: Context, config: Config): void {
  assertConfig(config)
  const log = loggerFor(ctx)
  ctx.effect(() => {
    const timer = startRetention(config, log)
    return () => clearInterval(timer)
  }, 'dsh-telegram: file retention')
  let started: Started | undefined
  let stopped = false
  ctx.effect(() => {
    void start(ctx, config).then((result) => {
      if (stopped) {
        void result.polling.stop().then(() => result.agents.disposeAll())
        return
      }
      started = result
    }).catch((error: unknown) => {
      log.error(`dsh-telegram: failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    })
    return () => {
      stopped = true
      if (started === undefined) return
      const { polling, agents } = started
      started = undefined
      void polling.stop().then(() => agents.disposeAll())
    }
  }, 'dsh-telegram: bot runner')
}
