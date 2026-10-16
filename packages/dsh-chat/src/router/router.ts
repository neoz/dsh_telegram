import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { chatKey, splitKey, type ChatKey } from '../keys.ts'
import { oneLine, senderLabel, type ChatLog, type ChatLogEntry } from '../log/chatlog.ts'
import { renderMemoryBlock, type MemoryStore } from '../memory/store.ts'
import type { ChatAgents, ChatSender, TurnContext } from '../sessions/agents.ts'
import type { ChatChannel, InboundImage, InboundMessage, PromptInput } from './channel.ts'
import { ChatQueue } from './queue.ts'
import { runAgentTurn, type AgentTurnResult, type SessionEventFeed } from './turn.ts'

export interface RouterConfig {
  /** userKeys allowed to get a turn; a Telegram username is written `telegram:@name`. */
  readonly allowFrom: string[]
  /** userKeys that may run commands and edit global memory; they still need to be in `allowFrom` to get a turn. */
  readonly superAdmins: string[]
  readonly recentMessagesLimit: number
  readonly turnTimeoutMs: number
}

export interface ImageStore {
  saveImages(images: ReadonlyArray<InboundImage>): Promise<ReadonlyArray<{ attachmentId: unknown }>>
}

type RouterAgents = Pick<ChatAgents,
  'resolve' | 'reset' | 'stop' | 'setTurn' | 'turnOf' | 'chatOf' | 'lastTurnMessageId' | 'markTurn' | 'memoryInjected' | 'markMemoryInjected'>

export interface RouterDeps {
  config: RouterConfig
  chatLog: ChatLog
  memory: MemoryStore
  agents: RouterAgents
  attachments: ImageStore
  feed: SessionEventFeed
  /** Emits `chat/turn`; idle work for that chat sees the turn coming and cancels. */
  emitTurn: (key: ChatKey) => void
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
}

export type Command = 'reset' | 'stop' | 'help'

export const HELP_TEXT = '/reset - start a new conversation\n/stop - cancel the running reply\n/help - show this list'
const RESET_DONE = 'Started a new conversation.'
const NOTHING_RUNNING = 'Nothing is running.'
const RESUME_FAILED = 'The previous conversation could not be restored; starting a new one.'
/** Strangers named in the log before the set starts over. */
const MAX_STRANGERS = 1000

export function commandOf(text: string): Command | undefined {
  const match = /^\/(reset|stop|help)\s*$/.exec(text)
  return match === null ? undefined : match[1] as Command
}

const errorText = (error: unknown) => (error instanceof Error ? error.stack ?? error.message : String(error))
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

/** Untrusted group text (other members included) fenced off from the user's own message; the persona names the tag as data. */
function recentBlock(entries: ChatLogEntry[]): string {
  return `<group_messages>\n${entries.map(e => `- ${senderLabel(e)}: ${oneLine(e.text)}`).join('\n')}\n</group_messages>`
}

interface ChatTurnInput {
  key: ChatKey
  sender: ChatSender
  isGroup: boolean
  text: string
  images: InboundImage[]
  /** The message this turn answers (quoted, given group context, marked); absent for a prompt. */
  messageId?: string
  startedAt: number
}

/** The `chat` service: channel registry, shared gate and commands, per-chat queue and turn orchestration. */
export class ChatRouter {
  private readonly channels = new Map<string, ChatChannel>()
  private readonly queue: ChatQueue
  private readonly strangers = new Set<string>()

  constructor(private readonly deps: RouterDeps) {
    this.queue = new ChatQueue((key, error) => deps.log.error(`dsh-chat: queued task in ${key} failed: ${errorText(error)}`))
  }

  get superAdmins(): readonly string[] {
    return this.deps.config.superAdmins
  }

  /** Adds a channel; the returned function removes it, and its queued work is skipped from then on. */
  register(channel: ChatChannel): () => void {
    if (this.channels.has(channel.id)) throw new Error(`dsh-chat: channel ${channel.id} is already registered`)
    this.channels.set(channel.id, channel)
    return () => {
      if (this.channels.get(channel.id) === channel) this.channels.delete(channel.id)
    }
  }

  channel(id: string): ChatChannel | undefined {
    return this.channels.get(id)
  }

  /** Appends a task to the chat's queue; tasks of one chat never overlap. Skipped when its channel is offline by then. */
  enqueue(key: ChatKey, task: () => Promise<void>): void {
    const { channel } = splitKey(key)
    this.queue.enqueue(key, async () => {
      if (!this.channels.has(channel)) {
        this.deps.log.warn(`dsh-chat: ${key} skipped queued work: channel offline`)
        return
      }
      await task()
    })
  }

  isBusy(key: ChatKey): boolean {
    return this.queue.isBusy(key)
  }

  chatOf(agentId: string): ChatKey | undefined {
    return this.deps.agents.chatOf(agentId)
  }

  turnOf(key: ChatKey): TurnContext | undefined {
    return this.deps.agents.turnOf(key)
  }

  private isSuperAdmin(key: ChatKey, sender: ChatSender): boolean {
    return this.deps.config.superAdmins.includes(chatKey(splitKey(key).channel, sender.id))
  }

  private isAllowed(key: ChatKey, sender: ChatSender): boolean {
    const { channel } = splitKey(key)
    const userKey = chatKey(channel, sender.id)
    const byName = sender.username === undefined ? undefined : `${channel}:@${sender.username.toLowerCase()}`
    return this.deps.config.allowFrom.some(entry => entry === userKey || (byName !== undefined && entry.toLowerCase() === byName))
  }

  /** Ids are opaque on some platforms, so this line is how an operator learns what to put in allowFrom; once per sender. */
  private noteStranger(key: ChatKey, sender: ChatSender): void {
    const userKey = chatKey(splitKey(key).channel, sender.id)
    if (this.strangers.has(userKey)) return
    if (this.strangers.size >= MAX_STRANGERS) this.strangers.clear()
    this.strangers.add(userKey)
    this.deps.log.info(`dsh-chat: ignored a private message in ${key} from ${userKey} (${sender.name}), who is not in allowFrom`)
  }

  inbound(message: InboundMessage): void {
    const key = message.chatKey
    const allowed = this.isAllowed(key, message.sender)
    if (!message.isGroup && !allowed) {
      this.noteStranger(key, message.sender)
      return
    }
    if (!allowed || !message.addressed) {
      this.enqueue(key, async () => {
        await this.deps.chatLog.append(key, (await message.load('log')).logEntry)
      })
      return
    }
    const command = this.isSuperAdmin(key, message.sender) ? commandOf(message.text) : undefined
    if (command === 'stop' || command === 'help') {
      void this.runCommand(key, command).catch((error: unknown) => {
        this.deps.log.error(`dsh-chat: /${command} in ${key} failed: ${errorText(error)}`)
      })
      return
    }
    if (command === 'reset') {
      // Cancel at once, dispose only after queued work, so no queued turn runs on a disposed agent.
      this.deps.agents.stop(key)
      this.enqueue(key, () => this.runCommand(key, 'reset'))
      return
    }
    // Noted on arrival as well, so idle work already queued for this chat sees the turn coming and cancels.
    this.deps.emitTurn(key)
    this.enqueue(key, () => this.handle(message))
  }

  /** Queues an agent turn nobody typed; it waits behind the chat's running and queued tasks. */
  prompt(key: ChatKey, input: PromptInput): void {
    this.enqueue(key, async () => {
      this.deps.emitTurn(key)
      const { result, prepMs } = await this.runChatTurn({ key, sender: input.sender, isGroup: input.isGroup, text: input.text, images: [], startedAt: Date.now() })
      this.deps.log.info(`dsh-chat: ${key} prompt -> ${result.outcome}`
        + ` (prep ${seconds(prepMs)}, agent ${seconds(result.timing.agentMs)}, deliver ${seconds(result.timing.deliverMs)})`)
    })
  }

  private channelOf(key: ChatKey): { channel: ChatChannel; id: string } {
    const { channel: channelId, id } = splitKey(key)
    const channel = this.channels.get(channelId)
    if (channel === undefined) throw new Error(`dsh-chat: ${key}: channel offline`)
    return { channel, id }
  }

  private async runCommand(key: ChatKey, command: Command): Promise<void> {
    const { channel, id } = this.channelOf(key)
    if (command === 'reset') {
      await this.deps.agents.reset(key)
      await channel.send(id, RESET_DONE)
    } else if (command === 'stop') {
      // A cancelled turn reports "Stopped." on its own; only an idle agent needs a reply here.
      if (!this.deps.agents.stop(key)) await channel.send(id, NOTHING_RUNNING)
    } else {
      await channel.send(id, HELP_TEXT)
    }
  }

  private async handle(message: InboundMessage): Promise<void> {
    const key = message.chatKey
    this.deps.emitTurn(key)
    const receivedAt = Date.now()
    const lagMs = Math.max(0, receivedAt - message.at)
    const loaded = await message.load('turn')
    await this.deps.chatLog.append(key, { ...loaded.logEntry, handled: true })
    const { result, prepMs } = await this.runChatTurn({
      key, sender: message.sender, isGroup: message.isGroup, text: loaded.text, images: loaded.images, messageId: message.messageId, startedAt: receivedAt,
    })
    this.deps.log.info(`dsh-chat: ${key} message ${message.messageId} -> ${result.outcome}`
      + ` (lag ${seconds(lagMs)}, prep ${seconds(prepMs)}, agent ${seconds(result.timing.agentMs)}, deliver ${seconds(result.timing.deliverMs)})`)
  }

  /** Chat plus global memory for the first turn of a session; undefined when reading failed, so the session stays unmarked. */
  private async memoryBlock(key: ChatKey): Promise<string | undefined> {
    try {
      const [chat, global] = await Promise.all([this.deps.memory.list({ kind: 'chat', key }), this.deps.memory.list({ kind: 'global' })])
      return renderMemoryBlock(chat, global)
    } catch (error) {
      this.deps.log.warn(`dsh-chat: reading memory for ${key} failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** Resolves the chat's agent, assembles the turn text, runs it through the channel and logs the reply. */
  private async runChatTurn(input: ChatTurnInput): Promise<{ result: AgentTurnResult; prepMs: number }> {
    const { key, messageId } = input
    const { channel, id } = this.channelOf(key)
    const { agents } = this.deps
    const resolved = await agents.resolve(key)
    if (resolved.resumeFailed !== undefined) await channel.send(id, RESUME_FAILED)
    agents.setTurn(key, { sender: input.sender, isGroup: input.isGroup, isSuperAdmin: this.isSuperAdmin(key, input.sender) })

    let text = input.text
    if (input.isGroup && messageId !== undefined) {
      const recent = await this.deps.chatLog.recent(key, agents.lastTurnMessageId(key), messageId, this.deps.config.recentMessagesLimit)
      if (recent.length > 0) text = `${recentBlock(recent)}\n\n${text}`
    }
    // The memory block goes in front of the first user message of a session; later turns rely on memory_recall.
    const sessionId = String(resolved.agent.id)
    const memoryText = agents.memoryInjected(key, sessionId) ? '' : await this.memoryBlock(key)
    if (memoryText !== undefined && memoryText !== '') text = `${memoryText}\n\n${text}`
    if (messageId !== undefined) await agents.markTurn(key, messageId)

    const content: ContentBlock[] = [{ type: 'text', text }]
    if (input.images.length > 0) {
      const refs = await this.deps.attachments.saveImages(input.images)
      for (const ref of refs) content.push({ type: 'image', attachment: ref as never })
    }
    const prepMs = Date.now() - input.startedAt
    if (memoryText !== undefined) await agents.markMemoryInjected(key, sessionId)

    const sink = await channel.openTurn(id, messageId === undefined ? {} : { replyTo: messageId })
    const result = await runAgentTurn({ agent: resolved.agent, feed: this.deps.feed, content, sink, turnTimeoutMs: this.deps.config.turnTimeoutMs })
    if (result.text !== '') {
      await this.deps.chatLog.append(key, {
        ts: new Date().toISOString(),
        message_id: result.messageId ?? '',
        user_id: channel.bot.id,
        name: channel.bot.name,
        text: result.text,
        ...(messageId === undefined ? {} : { reply_to: messageId }),
        bot: true,
      })
    }
    return { result, prepMs }
  }
}
