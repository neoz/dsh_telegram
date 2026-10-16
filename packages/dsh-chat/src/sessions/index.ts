import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import type { ChatKey } from '../keys.ts'
import type {} from '../migrate/index.ts'
import { ChatAgents, type ModelRoute } from './agents.ts'
import { SessionMap } from './session-map.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatAgents: ChatAgents
  }
  interface Events {
    /** A chat's agent was created or resumed; plugins register that chat's tools on `agentCtx`. */
    'chat/agent'(agentCtx: Context, key: ChatKey): void
  }
}

export const Config: z<ModelRoute> = z.object({
  provider: z.string().default('deepseek-official'),
  model: z.string().required(),
  reasoningEffort: z.string(),
})

/** Cordis plugin name. */
export const name = 'dsh-chat-sessions'
export const inject = ['chatData', 'agents']

export function apply(ctx: Context, config: ModelRoute): void {
  const logger = ctx.logger('dsh-chat')
  const log = { info: (msg: string) => logger.info(msg), warn: (msg: string) => logger.warn(msg) }
  ctx.effect(() => {
    const map = new SessionMap(join(ctx.chatData.dataDir, 'sessions.json'))
    const agents = new ChatAgents({
      agents: ctx.agents,
      map,
      workspaceRoot: ctx.chatData.workspaceRoot,
      selection: config,
      setup: (agentCtx, _agent, key) => ctx.emit('chat/agent', agentCtx, key),
      log,
    })
    let stopped = false
    let revoke: (() => void) | undefined
    map.load().then(() => {
      if (!stopped) revoke = ctx.provide('chatAgents', agents)
    }, (error: unknown) => {
      logger.error(`dsh-chat: loading sessions.json failed: ${error instanceof Error ? error.message : String(error)}; chat agents stay stopped`)
    })
    return () => {
      stopped = true
      revoke?.()
      return agents.disposeAll()
    }
  }, 'dsh-chat: chatAgents')
}
