import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-tools'
import { createDispatcher } from './bot.ts'
import { ChatLog, type ChatLogEntry } from './chatlog.ts'
import { assertConfig, Config } from './config.ts'
import { MemoryStore } from './memory.ts'
import { startPolling, type Poller } from './poller.ts'
import { sweepOldFiles } from './retention.ts'
import type { ZaloService } from './service.ts'
import { SessionMap } from './session-map.ts'
import { ChatAgents } from './sessions.ts'
import { registerChatTools } from './tools.ts'
import { createZaloApi } from './zalo-api.ts'

export { Config } from './config.ts'
export type { Config as ZaloConfig } from './config.ts'
export type { ZaloService } from './service.ts'

/** Cordis plugin name. */
export const name = 'dsh-zalo'
/** Services required before the bot starts. */
export const inject = ['agents', 'tools', 'attachments', 'loader']

interface Started { poller: Poller; agents: ChatAgents; service: ZaloService }

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

  const chatLog = new ChatLog(join(config.dataDir, 'chatlog'), forwardAppends((chatId, entry) => ctx.emit('zalo/message', chatId, entry), log.warn), config.chatLogMaxEntries)
  const memory = new MemoryStore(join(config.dataDir, 'memory'), config.memory)
  const map = new SessionMap(join(config.dataDir, 'zalo-sessions.json'))
  await map.load()

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
      registerChatTools(agentCtx, { chatLog, chatId, memory, superAdmins: config.superAdmins, currentTurn: () => agents.turnOf(chatId) })
    },
    log,
  })

  const dispatcher = createDispatcher({
    api,
    config,
    chatLog,
    memory,
    agents,
    attachments: ctx.attachments,
    bot: me,
    log,
    noteTurn: chatId => ctx.emit('zalo/turn', chatId),
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
    agents,
    service: {
      api,
      chatLog,
      queue: dispatcher,
      bot: me,
      dataDir: config.dataDir,
      chatOf: agentId => agents.chatOf(agentId),
    },
  }
}

/** Chat-log listener that forwards lines as zalo/message; Cordis does not isolate listeners, so a throw only warns. */
export function forwardAppends(emit: (chatId: string, entry: ChatLogEntry) => void, warn: (msg: string) => void): (chatId: string, entry: ChatLogEntry) => void {
  return (chatId, entry) => {
    try {
      emit(chatId, entry)
    } catch (error) {
      warn(`dsh-zalo: a zalo/message listener failed: ${error instanceof Error ? error.message : String(error)}`)
    }
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

const DAY_MS = 86_400_000

/** Sweeps old inbox and outbox files now and then once a day; returns the timer to clear on stop. */
function startRetention(config: Config, log: ReturnType<typeof loggerFor>): NodeJS.Timeout {
  const sweep = () => {
    sweepOldFiles(config.workspaceRoot, config.fileRetentionDays * DAY_MS).catch((error: unknown) => {
      log.warn(`dsh-zalo: file retention sweep failed: ${error instanceof Error ? error.message : String(error)}`)
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
  }, 'dsh-zalo: file retention')
  let started: Started | undefined
  let revoke: (() => void) | undefined
  let stopped = false
  ctx.effect(() => {
    const cancel = retryStart(() => start(ctx, config), (result) => {
      if (stopped) {
        void result.poller.stop().then(() => result.agents.disposeAll())
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
      const { poller, agents } = started
      started = undefined
      // Dependants stop first, while the bot can still serve their last calls.
      revoke?.()
      revoke = undefined
      void poller.stop().then(() => agents.disposeAll())
    }
  }, 'dsh-zalo: bot runner')
}
