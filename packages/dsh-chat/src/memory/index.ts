import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '../migrate/index.ts'
import type {} from '../sessions/index.ts'
import { MemoryStore, type MemoryLimits } from './store.ts'
import { registerMemoryTools } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatMemory: MemoryStore
  }
}

export const Config: z<MemoryLimits> = z.object({
  maxEntries: z.number().min(1).default(50),
  maxGlobalEntries: z.number().min(1).default(50),
  maxEntryChars: z.number().min(1).default(200),
})

/** Cordis plugin name. */
export const name = 'dsh-chat-memory'
export const inject = ['chatData', 'chatAgents']

export function apply(ctx: Context, config: MemoryLimits): void {
  const memory = new MemoryStore(ctx.chatData.dataDir, config)
  ctx.on('chat/agent', (agentCtx, key) => {
    registerMemoryTools(agentCtx, { memory, key, currentTurn: () => ctx.chatAgents.turnOf(key) })
  })
  ctx.effect(() => ctx.provide('chatMemory', memory), 'dsh-chat: chatMemory')
}
