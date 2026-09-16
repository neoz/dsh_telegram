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

interface Started { runner: RunnerHandle; agents: ChatAgents }

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
      registerChatTools(agentCtx, { api, chatLog, chatId, workspaceDir: agents.workspaceFor(chatId), maxUploadBytes })
    },
    log,
  })

  const dispatch = createDispatcher({
    api,
    config,
    chatLog,
    agents,
    feed,
    attachments: ctx.attachments,
    botId: bot.botInfo.id,
    botUsername: bot.botInfo.username,
    log,
  })
  bot.on('message', (update) => { dispatch(update.message as unknown as TelegramMessage) })
  bot.catch((error) => { log.error(`dsh-telegram: update handler failed: ${String(error.error)}`) })

  const runner = run(bot, { runner: { maxRetryTime: config.pollRetryMs, retryInterval: 'exponential' } })
  // A polling failure that outlives the retry window must not take the dsh process down with it.
  runner.task()?.catch((error: unknown) => {
    log.error(`dsh-telegram: polling stopped: ${error instanceof Error ? error.message : String(error)}`)
  })
  log.info(`dsh-telegram: polling as @${bot.botInfo.username}`)
  return { runner, agents }
}

export function apply(ctx: Context, config: Config): void {
  assertConfig(config)
  const log = loggerFor(ctx)
  let started: Started | undefined
  let stopped = false
  ctx.effect(() => {
    void start(ctx, config).then((result) => {
      if (stopped) {
        void result.runner.stop()
        void result.agents.disposeAll()
        return
      }
      started = result
    }).catch((error: unknown) => {
      log.error(`dsh-telegram: failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    })
    return () => {
      stopped = true
      if (started === undefined) return
      const { runner, agents } = started
      started = undefined
      void runner.stop().then(() => agents.disposeAll())
    }
  }, 'dsh-telegram: bot runner')
}
