import type { SendFileOptions, SendTextOptions, TelegramApi } from '../../src/telegram-api.ts'

export interface RecordedCall { method: string; args: unknown[] }

export class FakeTelegramApi implements TelegramApi {
  calls: RecordedCall[] = []
  files = new Map<string, { data: Buffer; filePath: string }>()
  private nextId = 100
  private failures = new Map<string, Error[]>()

  failNext(method: string, error: Error): void {
    const queue = this.failures.get(method) ?? []
    queue.push(error)
    this.failures.set(method, queue)
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter(c => c.method === method)
  }

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args })
    const queue = this.failures.get(method)
    const error = queue?.shift()
    if (error !== undefined) throw error
  }

  async sendMessage(chatId: number, text: string, options?: SendTextOptions) {
    this.record('sendMessage', [chatId, text, options])
    return { messageId: this.nextId++ }
  }
  async editMessageText(chatId: number, messageId: number, text: string, options?: { parseMode?: 'HTML' }) {
    this.record('editMessageText', [chatId, messageId, text, options])
  }
  async deleteMessage(chatId: number, messageId: number) {
    this.record('deleteMessage', [chatId, messageId])
  }
  async sendChatAction(chatId: number, action: 'typing') {
    this.record('sendChatAction', [chatId, action])
  }
  async setReaction(chatId: number, messageId: number, emoji: string) {
    this.record('setReaction', [chatId, messageId, emoji])
  }
  async sendDocument(chatId: number, data: Buffer, options: SendFileOptions & { filename: string }) {
    this.record('sendDocument', [chatId, data, options])
    return { messageId: this.nextId++ }
  }
  async sendPhoto(chatId: number, data: Buffer, options?: SendFileOptions) {
    this.record('sendPhoto', [chatId, data, options])
    return { messageId: this.nextId++ }
  }
  async downloadFile(fileId: string) {
    this.record('downloadFile', [fileId])
    const file = this.files.get(fileId)
    if (file === undefined) throw new Error(`no fake file ${fileId}`)
    return file
  }
}
