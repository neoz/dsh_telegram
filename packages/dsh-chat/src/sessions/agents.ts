import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type CreateAgentOptions, type ModelSelectionRef, type ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { pathSafe, splitKey, type ChatKey } from '../keys.ts'
import type { SessionMap } from './session-map.ts'

/** Who sent the running turn, in channel-neutral form. */
export interface ChatSender { id: string; name: string; username?: string }

/** Who started the turn running in a chat, whether that chat is a group, and whether the sender is a super admin there. */
export interface TurnContext { sender: ChatSender; isGroup: boolean; isSuperAdmin: boolean }

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
  setup: (agentCtx: Context, agent: Agent, key: ChatKey) => void
  log: { info(msg: string): void; warn(msg: string): void }
}

export interface ResolvedAgent { agent: Agent; resumed: boolean; resumeFailed?: string }

/** One live or persisted dsh agent per chat key, across channels. */
export class ChatAgents {
  private readonly handles = new Map<ChatKey, AgentHandle>()
  private readonly turns = new Map<ChatKey, TurnContext>()

  constructor(private readonly options: ChatAgentsOptions) {}

  /** Model route every chat agent uses; idle engagement calls the same model. */
  get selection(): ModelRoute {
    return this.options.selection
  }

  workspaceFor(key: ChatKey): string {
    const { channel, id } = splitKey(key)
    return join(this.options.workspaceRoot, channel, pathSafe(id))
  }

  lastTurnMessageId(key: ChatKey): string {
    return this.options.map.get(key)?.lastTurnMessageId ?? ''
  }

  async markTurn(key: ChatKey, lastTurnMessageId: string): Promise<void> {
    const record = this.options.map.get(key)
    if (record === undefined) return
    await this.options.map.set(key, { ...record, lastTurnMessageId })
  }

  setTurn(key: ChatKey, turn: TurnContext): void {
    this.turns.set(key, turn)
  }

  turnOf(key: ChatKey): TurnContext | undefined {
    return this.turns.get(key)
  }

  /** Chat whose live agent has this id; undefined for subagents and unknown sessions. */
  chatOf(agentId: string): ChatKey | undefined {
    for (const [key, handle] of this.handles) {
      if (String(handle.agent.id) === agentId) return key
    }
    return undefined
  }

  memoryInjected(key: ChatKey, sessionId: string): boolean {
    const record = this.options.map.get(key)
    return record?.sessionId === sessionId && record.memoryInjected === true
  }

  async markMemoryInjected(key: ChatKey, sessionId: string): Promise<void> {
    const record = this.options.map.get(key)
    if (record?.sessionId !== sessionId) return
    await this.options.map.set(key, { ...record, memoryInjected: true })
  }

  async resolve(key: ChatKey): Promise<ResolvedAgent> {
    const record = this.options.map.get(key)
    const live = this.handles.get(key)
    if (live !== undefined && record !== undefined && this.options.agents.get(brandString<SessionId>(record.sessionId)) !== undefined) {
      return { agent: live.agent, resumed: false }
    }
    if (record !== undefined) {
      try {
        const handle = await this.options.agents.resume({
          resumeSessionId: brandString<SessionId>(record.sessionId),
          agentOptions: this.route(),
          setup: (agentCtx, agent) => this.compose(agentCtx, agent, key),
        })
        this.handles.set(key, handle)
        this.options.log.info(`dsh-chat: resumed session ${record.sessionId} for chat ${key}`)
        return { agent: handle.agent, resumed: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.options.log.warn(`dsh-chat: resume of ${record.sessionId} failed (${message}); starting fresh`)
        await this.options.map.delete(key)
        const created = await this.create(key)
        return { ...created, resumeFailed: message }
      }
    }
    return this.create(key)
  }

  private async create(key: ChatKey): Promise<ResolvedAgent> {
    const cwd = this.workspaceFor(key)
    await mkdir(cwd, { recursive: true })
    const { channel, id } = splitKey(key)
    const sessionId = `${channel}-${pathSafe(id)}-${randomUUID()}`
    const handle = await this.options.agents.create({
      sessionId: brandString<SessionId>(sessionId),
      meta: { cwd },
      agentOptions: this.route(),
      setup: (agentCtx, agent) => this.compose(agentCtx, agent, key),
    })
    this.handles.set(key, handle)
    await this.options.map.set(key, { sessionId, lastTurnMessageId: '' })
    this.options.log.info(`dsh-chat: created session ${sessionId} for chat ${key}`)
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

  private compose(agentCtx: Context, agent: Agent, key: ChatKey): void {
    const selection: ModelSelectionRef = { current: this.route(), assembled: undefined }
    installModelSelection(agentCtx, selection)
    this.options.setup(agentCtx, agent, key)
  }

  async reset(key: ChatKey): Promise<void> {
    const handle = this.handles.get(key)
    this.handles.delete(key)
    this.turns.delete(key)
    await this.options.map.delete(key)
    if (handle === undefined) return
    // Let a running turn wind down (and deliver its "Stopped.") before the agent goes away.
    if (handle.agent.status === 'running') {
      handle.agent.cancel({ kind: 'user' })
      await handle.agent.whenIdle()
    }
    await handle.dispose()
  }

  stop(key: ChatKey): boolean {
    const handle = this.handles.get(key)
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
