import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { formatEntry, type ChatLog } from './chatlog.ts'
import { outboundKind, resolveInsideWorkspace } from './media.ts'
import type { TelegramApi } from './telegram-api.ts'

export interface ToolDeps {
  api: TelegramApi
  chatLog: ChatLog
  chatId: number
  workspaceDir: string
  maxUploadBytes: number
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
      return entries.length === 0 ? '(no messages)' : entries.map(formatEntry).join('\n')
    },
  })
}

interface ToolHost {
  tools: { register(tool: ToolDefinition): () => void }
  effect(fn: () => () => void, label?: string): void
}

/** Register both chat-scoped tools on an agent context; disposal unwinds them. */
export function registerChatTools(agentCtx: ToolHost, deps: ToolDeps): void {
  agentCtx.effect(() => agentCtx.tools.register(createSendFileTool(deps)), 'dsh-telegram: telegram_send_file')
  agentCtx.effect(() => agentCtx.tools.register(createChatHistoryTool(deps)), 'dsh-telegram: telegram_chat_history')
}
