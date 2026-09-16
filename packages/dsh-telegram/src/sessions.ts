import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type CreateAgentOptions, type ModelSelectionRef, type ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionMap } from './session-map.ts'

/** The slice of `ctx.agents` this module uses; the real registry satisfies it structurally. */
export interface AgentRegistryLike {
  get(id: SessionId): Agent | undefined
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
}

export interface ModelRoute { provider: string; model: string; reasoningEffort?: string }

export interface ChatAgentsOptions {
  agents: AgentRegistryLike
  map: SessionMap
  workspaceRoot: string
  selection: ModelRoute
  setup: (agentCtx: Context, agent: Agent, chatId: number) => void
  log: { info(msg: string): void; warn(msg: string): void }
}

export interface ResolvedAgent { agent: Agent; resumed: boolean; resumeFailed?: string }

/** One live or persisted dsh agent per Telegram chat. */
export class ChatAgents {
  private readonly handles = new Map<number, AgentHandle>()

  constructor(private readonly options: ChatAgentsOptions) {}

  workspaceFor(chatId: number): string {
    return join(this.options.workspaceRoot, String(chatId))
  }

  lastTurnMessageId(chatId: number): number {
    return this.options.map.get(chatId)?.lastTurnMessageId ?? 0
  }

  async markTurn(chatId: number, lastTurnMessageId: number): Promise<void> {
    const record = this.options.map.get(chatId)
    if (record === undefined) return
    await this.options.map.set(chatId, { ...record, lastTurnMessageId })
  }

  async resolve(chatId: number): Promise<ResolvedAgent> {
    const record = this.options.map.get(chatId)
    const live = this.handles.get(chatId)
    if (live !== undefined && record !== undefined && this.options.agents.get(brandString<SessionId>(record.sessionId)) !== undefined) {
      return { agent: live.agent, resumed: false }
    }
    if (record !== undefined) {
      try {
        const handle = await this.options.agents.resume({
          resumeSessionId: brandString<SessionId>(record.sessionId),
          agentOptions: this.route(),
          setup: (agentCtx, agent) => this.compose(agentCtx, agent, chatId),
        })
        this.handles.set(chatId, handle)
        this.options.log.info(`dsh-telegram: resumed session ${record.sessionId} for chat ${chatId}`)
        return { agent: handle.agent, resumed: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.options.log.warn(`dsh-telegram: resume of ${record.sessionId} failed (${message}); starting fresh`)
        await this.options.map.delete(chatId)
        const created = await this.create(chatId)
        return { ...created, resumeFailed: message }
      }
    }
    return this.create(chatId)
  }

  private async create(chatId: number): Promise<ResolvedAgent> {
    const cwd = this.workspaceFor(chatId)
    await mkdir(cwd, { recursive: true })
    const sessionId = `telegram-${chatId}-${randomUUID()}`
    const handle = await this.options.agents.create({
      sessionId: brandString<SessionId>(sessionId),
      meta: { cwd },
      agentOptions: this.route(),
      setup: (agentCtx, agent) => this.compose(agentCtx, agent, chatId),
    })
    this.handles.set(chatId, handle)
    await this.options.map.set(chatId, { sessionId, lastTurnMessageId: 0 })
    this.options.log.info(`dsh-telegram: created session ${sessionId} for chat ${chatId}`)
    return { agent: handle.agent, resumed: false }
  }

  private route() {
    const { provider, model, reasoningEffort } = this.options.selection
    return {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
    }
  }

  private compose(agentCtx: Context, agent: Agent, chatId: number): void {
    const selection: ModelSelectionRef = { current: this.route(), assembled: undefined }
    installModelSelection(agentCtx, selection)
    this.options.setup(agentCtx, agent, chatId)
  }

  async reset(chatId: number): Promise<void> {
    const handle = this.handles.get(chatId)
    this.handles.delete(chatId)
    await this.options.map.delete(chatId)
    if (handle !== undefined) await handle.dispose()
  }

  stop(chatId: number): boolean {
    const handle = this.handles.get(chatId)
    if (handle === undefined || handle.agent.status !== 'running') return false
    handle.agent.cancel({ kind: 'user' })
    return true
  }

  async disposeAll(): Promise<void> {
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))
  }
}
