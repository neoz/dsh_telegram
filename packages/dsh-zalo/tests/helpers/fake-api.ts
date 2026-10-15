import type { ZaloApi, ZaloUpdate } from '../../src/zalo-api.ts'

export interface RecordedCall { method: string; args: unknown[] }

export class FakeZaloApi implements ZaloApi {
  calls: RecordedCall[] = []
  downloads = new Map<string, Buffer>()
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
    const error = this.failures.get(method)?.shift()
    if (error !== undefined) throw error
  }

  async getMe() {
    this.record('getMe', [])
    return { id: 'bot1', accountName: 'dshbot' }
  }
  async getUpdates(timeoutSec: number): Promise<ZaloUpdate[]> {
    this.record('getUpdates', [timeoutSec])
    return []
  }
  async sendMessage(chatId: string, text: string, options?: { parseMode?: 'markdown' }) {
    this.record('sendMessage', [chatId, text, options])
    return { messageId: `m${this.nextId++}` }
  }
  async sendChatAction(chatId: string, action: 'typing') {
    this.record('sendChatAction', [chatId, action])
  }
  async downloadUrl(url: string) {
    this.record('downloadUrl', [url])
    const data = this.downloads.get(url)
    if (data === undefined) throw new Error(`no fake download ${url}`)
    return data
  }
}
