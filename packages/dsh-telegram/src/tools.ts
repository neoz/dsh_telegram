import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { formatEntry, type ChatLog } from './chatlog.ts'
import { outboundKind, resolveInsideWorkspace } from './media.ts'
import { formatMemoryEntry, type MemoryScope, type MemoryStore } from './memory.ts'
import type { TurnContext } from './sessions.ts'
import type { TelegramApi } from './telegram-api.ts'

export interface ToolDeps {
  api: TelegramApi
  chatLog: ChatLog
  chatId: number
  workspaceDir: string
  maxUploadBytes: number
  memory: MemoryStore
  superAdmins: readonly number[]
  /** The turn running in this chat; tools use it to authorise global writes. */
  currentTurn: () => TurnContext | undefined
}

const HISTORY_LIMIT_MAX = 100
const HISTORY_LIMIT_DEFAULT = 50

export function createSendFileTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'telegram_send_file',
    description: 'Send a file from the chat workspace to the current Telegram chat. Images are sent as photos, everything else as documents.',
    parameters: {
      path: { type: 'string', required: true, description: 'File path, relative to the workspace or absolute inside it' },
      caption: { type: 'string', description: 'Optional caption shown with the file' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const path = await resolveInsideWorkspace(deps.workspaceDir, args.path)
      const size = (await stat(path)).size
      if (size > deps.maxUploadBytes) {
        throw new Error(`file size ${size} bytes exceeds the upload limit of ${deps.maxUploadBytes} bytes`)
      }
      const data = await readFile(path)
      const filename = basename(path)
      const options = { filename, ...(args.caption === undefined ? {} : { caption: args.caption }) }
      if (outboundKind(path) === 'photo') await deps.api.sendPhoto(deps.chatId, data, options)
      else await deps.api.sendDocument(deps.chatId, data, options)
      return `Sent ${filename}`
    },
  })
}

export function createChatHistoryTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'telegram_chat_history',
    description: 'Read earlier messages of the current Telegram chat, including messages from people the assistant did not reply to. Returns oldest first.',
    parameters: {
      limit: { type: 'integer', description: `Number of messages to return (default ${HISTORY_LIMIT_DEFAULT}, max ${HISTORY_LIMIT_MAX})` },
      before_message_id: { type: 'integer', description: 'Only messages with a smaller Telegram message id' },
      query: { type: 'string', description: 'Case-insensitive substring filter on the message text' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const limit = Math.min(HISTORY_LIMIT_MAX, Math.max(1, args.limit ?? HISTORY_LIMIT_DEFAULT))
      const entries = await deps.chatLog.history(deps.chatId, {
        limit,
        ...(args.before_message_id === undefined ? {} : { beforeMessageId: args.before_message_id }),
        ...(args.query === undefined ? {} : { query: args.query }),
      })
      return entries.length === 0 ? '(no messages)' : `<chat_history>\n${entries.map(formatEntry).join('\n')}\n</chat_history>`
    },
  })
}

const WRITE_SCOPES = ['chat', 'global'] as const
const RECALL_SCOPES = ['chat', 'global', 'all'] as const

function scopeOf(deps: ToolDeps, name: 'chat' | 'global'): MemoryScope {
  return name === 'global' ? { kind: 'global' } : { kind: 'chat', chatId: deps.chatId }
}

/** Global memory is public to every chat: only a super admin may edit it, and only from a private chat, where no stranger's text is in context. */
function assertGlobalWrite(deps: ToolDeps): void {
  const turn = deps.currentTurn()
  if (turn?.isGroup) throw new Error('global memory can only be edited from a private chat with the bot')
  if (turn === undefined || !deps.superAdmins.includes(turn.sender.id)) throw new Error('only super admins can edit global memory')
}

export function createMemorySaveTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_save',
    description: 'Store one short fact in persistent memory. Scope "chat" (default) is the memory of this conversation; "global" is shared with every chat and can only be edited by a super admin from a private chat. Pass replace_id to update an existing entry instead of adding a new one.',
    parameters: {
      text: { type: 'string', required: true, description: 'The fact to remember, one short sentence' },
      scope: { type: 'string', enum: WRITE_SCOPES, description: 'chat (default) or global' },
      replace_id: { type: 'integer', description: 'Id of an existing entry to overwrite' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const scope = args.scope ?? 'chat'
      if (scope === 'global') assertGlobalWrite(deps)
      const entry = await deps.memory.save(scopeOf(deps, scope), args.text, args.replace_id)
      return `${args.replace_id === undefined ? 'Saved' : 'Replaced'} ${formatMemoryEntry(entry)}`
    },
  })
}

export function createMemoryRecallTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_recall',
    description: 'List persistent memory entries, oldest first. Scope "all" (default) returns both the memory of this conversation and the global memory.',
    parameters: {
      scope: { type: 'string', enum: RECALL_SCOPES, description: 'chat, global, or all (default)' },
      query: { type: 'string', description: 'Case-insensitive substring filter on the entry text' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const scope = args.scope ?? 'all'
      const needle = args.query?.toLowerCase()
      const section = async (label: string, target: MemoryScope): Promise<string> => {
        const entries = (await deps.memory.list(target)).filter(e => needle === undefined || e.text.toLowerCase().includes(needle))
        return `${label}:\n${entries.length === 0 ? '(none)' : entries.map(formatMemoryEntry).join('\n')}`
      }
      const parts: string[] = []
      if (scope !== 'global') parts.push(await section('Chat memory', scopeOf(deps, 'chat')))
      if (scope !== 'chat') parts.push(await section('Global memory', scopeOf(deps, 'global')))
      return parts.join('\n\n')
    },
  })
}

export function createMemoryForgetTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_forget',
    description: 'Delete one persistent memory entry by id. Global entries can only be deleted by a super admin from a private chat.',
    parameters: {
      scope: { type: 'string', enum: WRITE_SCOPES, required: true, description: 'chat or global' },
      id: { type: 'integer', required: true, description: 'Entry id as shown in [#id]' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      if (args.scope === 'global') assertGlobalWrite(deps)
      await deps.memory.forget(scopeOf(deps, args.scope), args.id)
      return `Forgot [#${args.id}]`
    },
  })
}

interface ToolHost {
  tools: { register(tool: ToolDefinition): () => void }
  effect(fn: () => () => void, label?: string): void
}

/** Register the chat-scoped tools on an agent context; disposal unwinds them. */
export function registerChatTools(agentCtx: ToolHost, deps: ToolDeps): void {
  agentCtx.effect(() => agentCtx.tools.register(createSendFileTool(deps)), 'dsh-telegram: telegram_send_file')
  agentCtx.effect(() => agentCtx.tools.register(createChatHistoryTool(deps)), 'dsh-telegram: telegram_chat_history')
  agentCtx.effect(() => agentCtx.tools.register(createMemorySaveTool(deps)), 'dsh-telegram: memory_save')
  agentCtx.effect(() => agentCtx.tools.register(createMemoryRecallTool(deps)), 'dsh-telegram: memory_recall')
  agentCtx.effect(() => agentCtx.tools.register(createMemoryForgetTool(deps)), 'dsh-telegram: memory_forget')
}
