import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ChatKey } from '../keys.ts'
import { formatEntry, type ChatLog } from '../log/chatlog.ts'
import type {} from '../log/index.ts'
import type {} from '../sessions/index.ts'

const HISTORY_LIMIT_MAX = 100
const HISTORY_LIMIT_DEFAULT = 50

export function createChatHistoryTool(deps: { chatLog: ChatLog; key: ChatKey }): ToolDefinition {
  return defineTool({
    name: 'chat_history',
    description: 'Read earlier messages of the current chat, including messages from people the assistant did not reply to. Returns oldest first.',
    parameters: {
      limit: { type: 'integer', description: `Number of messages to return (default ${HISTORY_LIMIT_DEFAULT}, max ${HISTORY_LIMIT_MAX})` },
      before_message_id: { type: 'string', description: 'Only messages logged before the message with this id' },
      query: { type: 'string', description: 'Case-insensitive substring filter on the message text' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const limit = Math.min(HISTORY_LIMIT_MAX, Math.max(1, args.limit ?? HISTORY_LIMIT_DEFAULT))
      const entries = await deps.chatLog.history(deps.key, {
        limit,
        ...(args.before_message_id === undefined ? {} : { beforeMessageId: args.before_message_id }),
        ...(args.query === undefined ? {} : { query: args.query }),
      })
      return entries.length === 0 ? '(no messages)' : `<chat_history>\n${entries.map(formatEntry).join('\n')}\n</chat_history>`
    },
  })
}

/** Cordis plugin name. */
export const name = 'dsh-chat-history'
export const inject = ['chatLog', 'chatAgents']

export function apply(ctx: Context): void {
  ctx.on('chat/agent', (agentCtx, key) => {
    const tool = createChatHistoryTool({ chatLog: ctx.chatLog, key })
    agentCtx.effect(() => agentCtx.tools.register(tool), 'dsh-chat: chat_history')
  })
}
