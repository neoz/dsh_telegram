import { join } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { chatKey, oneLine, renderMemoryBlock, senderLabel, type ChatAgents, type ChatLog, type ChatLogEntry, type MemoryStore } from 'dsh-chat'
import type { Config } from './config.ts'
import { bodyText, hasTrigger, logEntryFor, parseInbound, stripTrigger, type TriggerOptions } from './inbound.ts'
import type { ImageMediaType } from './media.ts'
import type { SeenIds } from './poller.ts'
import { runTurn } from './turn.ts'
import { isGroupChat, type ZaloApi, type ZaloUpdate, type ZaloUser } from './zalo-api.ts'

export type GateVerdict = 'ignore' | 'log-only' | 'handle'

export interface ImageStore {
  saveImages(images: ReadonlyArray<{ data: Uint8Array; mediaType: ImageMediaType }>): Promise<ReadonlyArray<{ attachmentId: unknown }>>
}

export interface BotDeps {
  api: ZaloApi
  config: Config
  chatLog: ChatLog
  memory: MemoryStore
  agents: ChatAgents
  attachments: ImageStore
  bot: { id: string; accountName: string; displayName?: string }
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
  /** Called when a message is about to get a turn (not for commands or log-only messages). */
  noteTurn?: (chatId: string) => void
  /** Senders already logged as not allowed; each is logged once. Without it every message is logged. */
  strangers?: SeenIds
}

/** Ids only: Zalo display names are chosen by the sender and prove nothing. */
export function isAllowed(user: ZaloUser, allowFrom: readonly string[]): boolean {
  return allowFrom.some(entry => entry.trim() === user.id)
}

export function gate(update: ZaloUpdate, options: TriggerOptions & { allowFrom: readonly string[]; botId: string }): GateVerdict {
  const { message } = update
  const sender = message.from
  if (sender === undefined || sender.is_bot === true || sender.id === options.botId) return 'ignore'
  const allowed = isAllowed(sender, options.allowFrom)
  if (!isGroupChat(message.chat)) return allowed ? 'handle' : 'ignore'
  return allowed && hasTrigger(bodyText(message), options) ? 'handle' : 'log-only'
}

export type Command = 'reset' | 'stop' | 'help'

const HELP_TEXT = '/reset - start a new conversation\n/stop - cancel the running reply\n/help - show this list'

export function commandOf(text: string): Command | undefined {
  const match = /^\s*\/(reset|stop|help)\s*$/.exec(text)
  return match === null ? undefined : match[1] as Command
}

/** How group messages address this bot. */
const triggerOf = (deps: BotDeps): TriggerOptions => ({
  accountName: deps.bot.accountName,
  ...(deps.bot.displayName === undefined ? {} : { displayName: deps.bot.displayName }),
  groupPrefix: deps.config.groupPrefix,
})

/** Super admins are always allowed: their commands and global-memory rights would be useless otherwise. */
const gateOptions = (deps: BotDeps) => ({
  allowFrom: [...deps.config.allowFrom, ...deps.config.superAdmins],
  botId: deps.bot.id,
  ...triggerOf(deps),
})

/** Commands are for super admins only; anyone else sending `/stop` gets an ordinary turn. */
function commandFrom(update: ZaloUpdate, deps: BotDeps): Command | undefined {
  const senderId = update.message.from?.id
  if (senderId === undefined || !deps.config.superAdmins.includes(senderId)) return undefined
  return commandOf(stripTrigger(bodyText(update.message), gateOptions(deps)))
}

/** Untrusted group text (other members included) fenced off from the user's own message; the persona names the tag as data. */
function recentBlock(entries: ChatLogEntry[]): string {
  return `<group_messages>\n${entries.map(e => `- ${senderLabel(e)}: ${oneLine(e.text)}`).join('\n')}\n</group_messages>`
}

/** Chat plus global memory for the first turn of a session; undefined when reading failed, so the session stays unmarked. */
async function memoryBlock(deps: BotDeps, chatId: string): Promise<string | undefined> {
  try {
    const [chat, global] = await Promise.all([deps.memory.list({ kind: 'chat', key: chatKey('zalo', chatId) }), deps.memory.list({ kind: 'global' })])
    return renderMemoryBlock(chat, global)
  } catch (error) {
    deps.log.warn(`dsh-zalo: reading memory for chat ${chatId} failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

async function runCommand(command: Command, chatId: string, deps: BotDeps): Promise<void> {
  if (command === 'reset') {
    await deps.agents.reset(chatKey('zalo', chatId))
    await deps.api.sendMessage(chatId, 'Started a new conversation.')
  } else if (command === 'stop') {
    // A cancelled turn reports "Stopped." on its own; only an idle agent needs a reply here.
    if (!deps.agents.stop(chatKey('zalo', chatId))) await deps.api.sendMessage(chatId, 'Nothing is running.')
  } else {
    await deps.api.sendMessage(chatId, HELP_TEXT)
  }
}

export async function handleMessage(update: ZaloUpdate, deps: BotDeps): Promise<void> {
  const verdict = gate(update, gateOptions(deps))
  const sender = update.message.from
  if (verdict === 'ignore') {
    // Zalo ids are opaque, so this line is how an operator learns the id to put in allowFrom.
    if (!isGroupChat(update.message.chat) && sender !== undefined && sender.is_bot !== true && (deps.strangers?.add(sender.id) ?? true)) {
      deps.log.info(`dsh-zalo: ignored a private message from ${sender.id} (${sender.display_name ?? ''}), who is not in allowFrom`)
    }
    return
  }
  const chatId = update.message.chat.id
  const key = chatKey('zalo', chatId)
  if (verdict === 'log-only') {
    await deps.chatLog.append(key, logEntryFor(update))
    return
  }
  const command = commandFrom(update, deps)
  if (command !== undefined) {
    await runCommand(command, chatId, deps)
    return
  }
  deps.noteTurn?.(chatId)

  const receivedAt = Date.now()
  const lagMs = Math.max(0, receivedAt - update.message.date)
  const inbound = await parseInbound(update, {
    api: deps.api, inboxDir: join(deps.agents.workspaceFor(key), 'inbox'), log: deps.log,
    ...triggerOf(deps),
  })
  await deps.chatLog.append(key, { ...inbound.logEntry, handled: true })

  const resolved = await deps.agents.resolve(key)
  if (resolved.resumeFailed !== undefined) {
    await deps.api.sendMessage(chatId, 'The previous conversation could not be restored; starting a new one.')
  }
  deps.agents.setTurn(key, {
    sender: { id: inbound.sender.id, name: inbound.sender.display_name ?? '' },
    isGroup: inbound.isGroup,
    isSuperAdmin: deps.config.superAdmins.includes(inbound.sender.id),
  })

  let text = inbound.text
  if (inbound.isGroup) {
    const recent = await deps.chatLog.recent(key, deps.agents.lastTurnMessageId(key), inbound.messageId, deps.config.recentMessagesLimit)
    if (recent.length > 0) text = `${recentBlock(recent)}\n\n${text}`
  }
  // The memory block goes in front of the first user message of a session; later turns rely on memory_recall.
  const sessionId = String(resolved.agent.id)
  const memoryText = deps.agents.memoryInjected(key, sessionId) ? '' : await memoryBlock(deps, chatId)
  if (memoryText !== undefined && memoryText !== '') text = `${memoryText}\n\n${text}`
  await deps.agents.markTurn(key, inbound.messageId)

  const content: ContentBlock[] = [{ type: 'text', text }]
  if (inbound.images.length > 0) {
    const refs = await deps.attachments.saveImages(inbound.images)
    for (const ref of refs) content.push({ type: 'image', attachment: ref as never })
  }
  const prepMs = Date.now() - receivedAt
  if (memoryText !== undefined) await deps.agents.markMemoryInjected(key, sessionId)

  const result = await runTurn({
    api: deps.api,
    agent: resolved.agent as never,
    chatId,
    content,
    messageSize: deps.config.messageSize,
    typingIntervalMs: deps.config.typingIntervalMs,
    turnTimeoutMs: deps.config.turnTimeoutMs,
    log: deps.log,
  })
  if (result.text !== '') {
    await deps.chatLog.append(key, {
      ts: new Date().toISOString(),
      message_id: result.sentMessageId ?? '',
      user_id: deps.bot.id,
      name: deps.bot.accountName,
      text: result.text,
      bot: true,
    })
  }
  deps.log.info(`dsh-zalo: chat ${chatId} message ${inbound.messageId} -> ${result.outcome}`
    + ` (lag ${seconds(lagMs)}, prep ${seconds(prepMs)}, agent ${seconds(result.timing.agentMs)}, deliver ${seconds(result.timing.deliverMs)})`)
}

export interface Dispatcher {
  dispatch(update: ZaloUpdate): void
  /** Appends a task to the chat's queue; tasks of one chat never overlap. */
  enqueue(chatId: string, task: () => Promise<void>): void
  /** Whether the chat has a running or waiting task. */
  isBusy(chatId: string): boolean
  /** Stops accepting work; queued tasks that have not started are skipped, a running one finishes. */
  close(): void
}

/**
 * Serialises message handling per chat so turns never overlap. `/stop` and `/help`
 * bypass the queue so they act on the turn that is running; `/reset` cancels that
 * turn at once but waits its turn to dispose the agent, so no queued message runs
 * on a disposed one. A failing task is logged and never blocks the next one.
 */
export function createDispatcher(deps: BotDeps): Dispatcher {
  const chains = new Map<string, Promise<void>>()
  let closed = false
  const report = (update: ZaloUpdate) => (error: unknown) => {
    deps.log.error(`dsh-zalo: message ${update.message.message_id} in chat ${update.message.chat.id} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
  const enqueue = (chatId: string, task: () => Promise<void>): void => {
    if (closed) return
    const previous = chains.get(chatId) ?? Promise.resolve()
    const next = previous
      .then(() => (closed ? undefined : task()))
      .catch((error: unknown) => {
        deps.log.error(`dsh-zalo: queued task in chat ${chatId} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      })
      .finally(() => {
        if (chains.get(chatId) === next) chains.delete(chatId)
      })
    chains.set(chatId, next)
  }
  return {
    dispatch(update) {
      if (closed) return
      const command = gate(update, gateOptions(deps)) === 'handle' ? commandFrom(update, deps) : undefined
      if (command === 'stop' || command === 'help') {
        void handleMessage(update, deps).catch(report(update))
        return
      }
      if (command === 'reset') deps.agents.stop(chatKey('zalo', update.message.chat.id))
      enqueue(update.message.chat.id, () => handleMessage(update, deps).catch(report(update)))
    },
    enqueue,
    isBusy: chatId => chains.has(chatId),
    close() {
      closed = true
    },
  }
}
