import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import { splitKey, type ChatKey } from '../keys.ts'
import type {} from '../log/index.ts'
import type {} from '../memory/index.ts'
import type {} from '../sessions/index.ts'
import { ChatRouter, type RouterConfig } from './router.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chat: ChatRouter
  }
  interface Events {
    /** An addressed message arrived or a turn is about to run in this chat. */
    'chat/turn'(key: ChatKey): void
  }
}

export const Config: z<RouterConfig> = z.object({
  allowFrom: z.array(z.string()).required(),
  superAdmins: z.array(z.string()).default([]),
  recentMessagesLimit: z.number().min(0).default(30),
  turnTimeoutMs: z.number().min(1).default(900_000),
})

/** Checks Schemastery cannot express; throws on the first violation. */
export function assertRouterConfig(config: RouterConfig): void {
  if (config.allowFrom.length === 0) throw new Error('dsh-chat: allowFrom must list at least one user key')
  for (const entry of [...config.allowFrom, ...config.superAdmins]) {
    try {
      splitKey(entry)
    } catch {
      throw new Error(`dsh-chat: "${entry}" is not a user key like telegram:123 or zalo:abc`)
    }
  }
}

/** Cordis plugin name. */
export const name = 'dsh-chat'
export const inject = ['chatLog', 'chatMemory', 'chatAgents', 'attachments']

export function apply(ctx: Context, config: RouterConfig): void {
  assertRouterConfig(config)
  const logger = ctx.logger('dsh-chat')
  const router = new ChatRouter({
    config,
    chatLog: ctx.chatLog,
    memory: ctx.chatMemory,
    agents: ctx.chatAgents,
    attachments: ctx.attachments,
    feed: listener => ctx.on('session/event', (session, event) => listener(String(session.id), event)),
    emitTurn: key => ctx.emit('chat/turn', key),
    log: { info: msg => logger.info(msg), warn: msg => logger.warn(msg), error: msg => logger.error(msg) },
  })
  ctx.effect(() => ctx.provide('chat', router), 'dsh-chat: chat')
}
