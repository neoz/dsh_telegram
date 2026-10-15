import type { ZaloApi, ZaloUpdate } from './zalo-api.ts'

/** Insertion-ordered set of recent message ids; getUpdates has no offset, so redelivery is filtered here. */
export class SeenIds {
  private readonly ids = new Set<string>()

  constructor(private readonly limit: number) {}

  /** True when `id` was not seen yet; it is remembered from now on. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false
    this.ids.add(id)
    if (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value as string)
    return true
  }
}

export interface PollerOptions {
  api: Pick<ZaloApi, 'getUpdates'>
  timeoutSec: number
  onUpdate: (update: ZaloUpdate) => void
  backoff: { startDelayMs: number; maxDelayMs: number }
  log: { warn(msg: string): void; error(msg: string): void }
  seenLimit?: number
}

export interface Poller { stop(): Promise<void> }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Long-polls until stopped; a failure backs off and retries, so the loop never ends on its own. */
export function startPolling(options: PollerOptions): Poller {
  const seen = new SeenIds(options.seenLimit ?? 1000)
  const abort = new AbortController()
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    abort.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })

  const loop = (async () => {
    let failures = 0
    while (!abort.signal.aborted) {
      let updates: ZaloUpdate[]
      try {
        updates = await options.api.getUpdates(options.timeoutSec, abort.signal)
        failures = 0
      } catch (error) {
        if (abort.signal.aborted) return
        const delayMs = Math.min(options.backoff.startDelayMs * 2 ** failures, options.backoff.maxDelayMs)
        failures++
        options.log.error(`dsh-zalo: getUpdates failed (${message(error)}); retrying in ${delayMs}ms`)
        await sleep(delayMs)
        continue
      }
      for (const update of updates) {
        const id = update.message?.message_id
        if (typeof id !== 'string') {
          options.log.warn(`dsh-zalo: skipped an update without a message (${update.event_name})`)
          continue
        }
        if (!seen.add(id)) continue
        try {
          options.onUpdate(update)
        } catch (error) {
          options.log.error(`dsh-zalo: update handler failed: ${message(error)}`)
        }
      }
    }
  })()

  return {
    async stop() {
      abort.abort()
      await loop
    },
  }
}
