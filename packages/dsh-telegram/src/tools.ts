import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { outboundKind, resolveInsideWorkspace } from './media.ts'
import type { TelegramApi } from './telegram-api.ts'

export interface ToolDeps {
  api: TelegramApi
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
      const data = await readFile(path)
      const filename = basename(path)
      const options = { filename, ...(args.caption === undefined ? {} : { caption: args.caption }) }
      if (outboundKind(path) === 'photo') await deps.api.sendPhoto(deps.chatId, data, options)
      else await deps.api.sendDocument(deps.chatId, data, options)
      return `Sent ${filename}`
    },
  })
}
