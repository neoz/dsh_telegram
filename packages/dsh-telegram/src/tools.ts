import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { outboundKind, resolveInsideWorkspace } from './media.ts'
import type { TelegramApi } from './telegram-api.ts'

export interface ToolDeps {
  /** The bot running now; undefined while it restarts. Read per call, so an agent outlives a bot restart. */
  api: () => TelegramApi | undefined
  chatId: number
  workspaceDir: string
  maxUploadBytes: number
}

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
      const api = deps.api()
      if (api === undefined) throw new Error('the Telegram bot is not running; try again shortly')
      const data = await readFile(path)
      const filename = basename(path)
      const options = { filename, ...(args.caption === undefined ? {} : { caption: args.caption }) }
      if (outboundKind(path) === 'photo') await api.sendPhoto(deps.chatId, data, options)
      else await api.sendDocument(deps.chatId, data, options)
      return `Sent ${filename}`
    },
  })
}
