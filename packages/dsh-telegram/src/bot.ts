import { join } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { oneLine, senderLabel, type ChatLog, type ChatLogEntry } from './chatlog.ts'
import type { Config } from './config.ts'
import { hasBotMention, logEntryFor, parseInbound, type TelegramMessage, type TelegramUser } from './inbound.ts'
import { renderMemoryBlock, type MemoryStore } from './memory.ts'
import type { ChatAgents } from './sessions.ts'
import type { TelegramApi } from './telegram-api.ts'
import { runTurn, type SessionEventFeed } from './turn.ts'

/** Reaction placed on every message the agent will answer. */
export const ACK_REACTION = '\u{1F47E}'

export type GateVerdict = 'ignore' | 'log-only' | 'handle'

export interface ImageStore {
  saveImages(images: ReadonlyArray<{ data: Uint8Array; mediaType: 'image/jpeg' }>): Promise<ReadonlyArray<{ attachmentId: unknown }>>
}

export interface BotDeps {
  api: TelegramApi
  config: Config
  chatLog: ChatLog
  memory: MemoryStore
  agents: ChatAgents
  feed: SessionEventFeed
  attachments: ImageStore
  botId: number
  botUsername: string
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
}

export function isAllowed(user: TelegramUser, allowFrom: readonly string[]): boolean {
  const username = user.username?.toLowerCase()
  return allowFrom.some((entry) => {
    const normalized = entry.trim().replace(/^@/, '').toLowerCase()
    return normalized === String(user.id) || (username !== undefined && normalized === username)
  })
}

export function gate(message: TelegramMessage, options: { allowFrom: readonly string[]; botId: number; botUsername: string }): GateVerdict {
  const sender = message.from
  if (sender === undefined || sender.is_bot) return 'ignore'
  const allowed = isAllowed(sender, options.allowFrom)
  if (message.chat.type === 'private') return allowed ? 'handle' : 'ignore'
  const targeted = hasBotMention(message.text, message.entities, options.botUsername)
    || hasBotMention(message.caption, message.caption_entities, options.botUsername)
    || message.reply_to_message?.from?.id === options.botId
  return allowed && targeted ? 'handle' : 'log-only'
}

export type Command = 'reset' | 'stop' | 'help'

const HELP_TEXT = '/reset - start a new conversation\n/stop - cancel the running reply\n/help - show this list'

export function commandOf(text: string | undefined, botUsername: string): Command | undefined {
  const match = /^\/(reset|stop|help)(?:@(\w+))?\s*$/.exec(text ?? '')
  if (match === null) return undefined
  if (match[2] !== undefined && match[2].toLowerCase() !== botUsername.toLowerCase()) return undefined
  return match[1] as Command
}

/** Commands are for super admins only; anyone else sending `/stop` gets an ordinary turn. */
function commandFrom(message: TelegramMessage, deps: BotDeps): Command | undefined {
  if (message.from === undefined || !deps.config.superAdmins.includes(message.from.id)) return undefined
  return commandOf(message.text, deps.botUsername)
}

/** Untrusted group text (other members included) fenced off from the user's own message; the persona names the tag as data. */
function recentBlock(entries: ChatLogEntry[]): string {
  return `<group_messages>\n${entries.map(e => `- ${senderLabel(e)}: ${oneLine(e.text)}`).join('\n')}\n</group_messages>`
}

/** Chat plus global memory for the first turn of a session; undefined when reading failed, so the turn runs without it and the session stays unmarked. */
async function memoryBlock(deps: BotDeps, chatId: number): Promise<string | undefined> {
  try {
    const [chat, global] = await Promise.all([deps.memory.list({ kind: 'chat', chatId }), deps.memory.list({ kind: 'global' })])
    return renderMemoryBlock(chat, global)
  } catch (error) {
    deps.log.warn(`dsh-telegram: reading memory for chat ${chatId} failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

export async function handleMessage(message: TelegramMessage, deps: BotDeps): Promise<void> {
  const verdict = gate(message, { allowFrom: deps.config.allowFrom, botId: deps.botId, botUsername: deps.botUsername })
  if (verdict === 'ignore') return
  const chatId = message.chat.id
  if (verdict === 'log-only') {
    await deps.chatLog.append(chatId, logEntryFor(message))
    return
  }

  const command = commandFrom(message, deps)
  if (command === 'reset') {
    await deps.agents.reset(chatId)
    await deps.api.sendMessage(chatId, 'Started a new conversation.')
    return
  }
  if (command === 'stop') {
    // A cancelled turn reports "Stopped." on its own placeholder; only an idle agent needs a reply here.
    if (!deps.agents.stop(chatId)) await deps.api.sendMessage(chatId, 'Nothing is running.')
    return
  }
  if (command === 'help') {
    await deps.api.sendMessage(chatId, HELP_TEXT)
    return
  }

  // Telegram stamps `date` when the sender hit send; the gap to now is delivery lag outside this process.
  const receivedAt = Date.now()
  const lagMs = Math.max(0, receivedAt - message.date * 1000)
  const workspaceDir = deps.agents.workspaceFor(chatId)
  const inbound = await parseInbound(message, {
    api: deps.api, inboxDir: join(workspaceDir, 'inbox'), botId: deps.botId, botUsername: deps.botUsername,
  })
  await deps.chatLog.append(chatId, inbound.logEntry)
  await deps.api.setReaction(chatId, message.message_id, ACK_REACTION)

  const resolved = await deps.agents.resolve(chatId)
  if (resolved.resumeFailed !== undefined) {
    await deps.api.sendMessage(chatId, 'The previous conversation could not be restored; starting a new one.')
  }

  deps.agents.setTurn(chatId, { sender: inbound.sender, isGroup: inbound.isGroup })

  let text = inbound.text
  if (inbound.isGroup) {
    const recent = await deps.chatLog.recent(chatId, deps.agents.lastTurnMessageId(chatId), message.message_id, deps.config.recentMessagesLimit)
    if (recent.length > 0) text = `${recentBlock(recent)}\n\n${text}`
  }
  // The memory block goes in front of the first user message of a session; later turns rely on memory_recall.
  const sessionId = resolved.agent.id
  const memoryText = deps.agents.memoryInjected(chatId, sessionId) ? '' : await memoryBlock(deps, chatId)
  if (memoryText !== undefined && memoryText !== '') text = `${memoryText}\n\n${text}`
  await deps.agents.markTurn(chatId, message.message_id)

  const content: ContentBlock[] = [{ type: 'text', text }]
  if (inbound.images.length > 0) {
    const refs = await deps.attachments.saveImages(inbound.images)
    for (const ref of refs) content.push({ type: 'image', attachment: ref as never })
  }

  const prepMs = Date.now() - receivedAt
  if (memoryText !== undefined) deps.agents.markMemoryInjected(chatId, sessionId)
  const result = await runTurn({
    api: deps.api,
    agent: resolved.agent,
    feed: deps.feed,
    chatId,
    replyToMessageId: message.message_id,
    content,
    outboxDir: join(workspaceDir, 'outbox'),
    messageSize: deps.config.messageSize,
    statusEditIntervalMs: deps.config.statusEditIntervalMs,
    turnTimeoutMs: deps.config.turnTimeoutMs,
    status: deps.config.status,
    log: deps.log,
  })

  if (result.text !== '') {
    await deps.chatLog.append(chatId, {
      ts: new Date().toISOString(),
      message_id: result.sentMessageId ?? 0,
      user_id: deps.botId,
      name: deps.botUsername,
      text: result.text,
      bot: true,
    })
  }
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`
  deps.log.info(`dsh-telegram: chat ${chatId} message ${message.message_id} -> ${result.outcome}`
    + ` (lag ${seconds(lagMs)}, prep ${seconds(prepMs)}, agent ${seconds(result.timing.agentMs)}, deliver ${seconds(result.timing.deliverMs)})`)
}

/**
 * Serialises message handling per chat so turns never overlap; commands bypass
 * the queue so `/stop` and `/reset` act on the turn that is running. A failing
 * handler is logged and never blocks the next one.
 */
export function createDispatcher(deps: BotDeps): (message: TelegramMessage) => void {
  const chains = new Map<number, Promise<void>>()
  const report = (message: TelegramMessage) => (error: unknown) => {
    deps.log.error(`dsh-telegram: message ${message.message_id} in chat ${message.chat.id} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
  return (message) => {
    const chatId = message.chat.id
    if (commandFrom(message, deps) !== undefined) {
      void handleMessage(message, deps).catch(report(message))
      return
    }
    const previous = chains.get(chatId) ?? Promise.resolve()
    const next = previous
      .then(() => handleMessage(message, deps))
      .catch(report(message))
      .finally(() => {
        if (chains.get(chatId) === next) chains.delete(chatId)
      })
    chains.set(chatId, next)
  }
}
