import type { ChatKey } from '../keys.ts'

/** Serialises tasks per chat key; a failing task is reported and never blocks the next one. */
export class ChatQueue {
  private readonly chains = new Map<ChatKey, Promise<void>>()

  constructor(private readonly onError: (key: ChatKey, error: unknown) => void) {}

  enqueue(key: ChatKey, task: () => Promise<void>): void {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous
      .then(task)
      .catch((error: unknown) => this.onError(key, error))
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key)
      })
    this.chains.set(key, next)
  }

  /** Whether the chat has a running or waiting task. */
  isBusy(key: ChatKey): boolean {
    return this.chains.has(key)
  }
}
