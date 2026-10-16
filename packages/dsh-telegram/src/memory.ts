import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { oneLine } from './chatlog.ts'
import { SerialQueue, writeJsonAtomic } from 'dsh-chat'

/** `chat` is the memory of one conversation (a private chat or a group); `global` is shared by every chat. */
export type MemoryScope = { kind: 'chat'; chatId: number } | { kind: 'global' }

export interface MemoryEntry { id: number; text: string; ts: string }

/** Caps enforced by the store; see the memory design spec. */
export interface MemoryLimits {
  readonly maxEntries: number
  readonly maxGlobalEntries: number
  readonly maxEntryChars: number
}

interface MemoryFile { nextId: number; entries: MemoryEntry[] }

export function formatMemoryEntry(entry: MemoryEntry): string {
  return `[#${entry.id}] ${oneLine(entry.text)}`
}

/** One small JSON file per scope under `dir`, rewritten atomically on every change; nothing is cached. */
export class MemoryStore {
  /** Chats share the global file, so every read-modify-write runs one at a time. */
  private readonly changes = new SerialQueue()

  constructor(private readonly dir: string, private readonly limits: MemoryLimits) {}

  private file(scope: MemoryScope): string {
    return join(this.dir, scope.kind === 'global' ? 'global.json' : `${scope.chatId}.json`)
  }

  private cap(scope: MemoryScope): number {
    return scope.kind === 'global' ? this.limits.maxGlobalEntries : this.limits.maxEntries
  }

  private async read(scope: MemoryScope): Promise<MemoryFile> {
    try {
      return JSON.parse(await readFile(this.file(scope), 'utf8')) as MemoryFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { nextId: 1, entries: [] }
      throw error
    }
  }

  private write(scope: MemoryScope, data: MemoryFile): Promise<void> {
    return writeJsonAtomic(this.file(scope), data)
  }

  async list(scope: MemoryScope): Promise<MemoryEntry[]> {
    return (await this.read(scope)).entries
  }

  /** Append one entry, or overwrite `replaceId`; errors carry a message written for the model. */
  async save(scope: MemoryScope, text: string, replaceId?: number): Promise<MemoryEntry> {
    const trimmed = text.trim()
    if (trimmed === '') throw new Error('memory text is empty')
    if (trimmed.length > this.limits.maxEntryChars) {
      throw new Error(`entry is ${trimmed.length} characters, the limit is ${this.limits.maxEntryChars}; shorten it`)
    }
    return this.changes.run(() => this.saveTrimmed(scope, trimmed, replaceId))
  }

  private async saveTrimmed(scope: MemoryScope, trimmed: string, replaceId: number | undefined): Promise<MemoryEntry> {
    const data = await this.read(scope)
    const ts = new Date().toISOString()
    if (replaceId !== undefined) {
      const existing = data.entries.find(e => e.id === replaceId)
      if (existing === undefined) throw new Error(`no memory entry #${replaceId}`)
      existing.text = trimmed
      existing.ts = ts
      await this.write(scope, data)
      return existing
    }
    const cap = this.cap(scope)
    if (data.entries.length >= cap) {
      throw new Error(`memory is full (${cap}/${cap}); replace or forget an entry first:\n${data.entries.map(formatMemoryEntry).join('\n')}`)
    }
    const entry: MemoryEntry = { id: data.nextId, text: trimmed, ts }
    data.nextId += 1
    data.entries.push(entry)
    await this.write(scope, data)
    return entry
  }

  forget(scope: MemoryScope, id: number): Promise<void> {
    return this.changes.run(async () => {
      const data = await this.read(scope)
      const index = data.entries.findIndex(e => e.id === id)
      if (index === -1) throw new Error(`no memory entry #${id}`)
      data.entries.splice(index, 1)
      await this.write(scope, data)
    })
  }
}

/** The block prepended to the first user turn of a session; empty when both scopes are empty. */
export function renderMemoryBlock(chat: MemoryEntry[], global: MemoryEntry[]): string {
  const sections: string[] = []
  if (chat.length > 0) sections.push(`[Memory of this conversation]\n${chat.map(e => `- ${formatMemoryEntry(e)}`).join('\n')}`)
  if (global.length > 0) sections.push(`[Global memory]\n${global.map(e => `- ${formatMemoryEntry(e)}`).join('\n')}`)
  return sections.length === 0 ? '' : `<memory>\n${sections.join('\n\n')}\n</memory>`
}
