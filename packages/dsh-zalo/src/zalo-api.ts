import type { RetryConfig } from './config.ts'

export const ZALO_API_BASE = 'https://bot-api.zaloplatforms.com'

export interface ZaloUser { id: string; display_name?: string; is_bot?: boolean }

/** A message as Zalo delivers it; only the fields of its `event_name` are present. */
export interface ZaloMessage {
  from: ZaloUser
  chat: { id: string; chat_type: 'PRIVATE' | 'GROUP' }
  message_id: string
  /** Milliseconds since the epoch. */
  date: number
  text?: string
  /** Photo URL; Zalo really sends it as `photo_url`, which `normalizeUpdate` maps here. */
  photo?: string
  /** What Zalo actually sends for `photo`, despite its docs. */
  photo_url?: string
  /** e.g. `CHAT_PHOTO`; undocumented. */
  message_type?: string
  caption?: string
  sticker?: string
  url?: string
  voice_url?: string
}

export interface ZaloUpdate { event_name: string; message: ZaloMessage }

/** Anything but an explicit private chat counts as a group, so an unexpected `chat_type` falls back to needing a trigger. */
export function isGroupChat(chat: ZaloMessage['chat']): boolean {
  return String(chat.chat_type).toUpperCase() !== 'PRIVATE'
}

const DOCUMENTED_UPDATE = new Set(['event_name', 'message'])
const DOCUMENTED_MESSAGE = new Set(['from', 'chat', 'message_id', 'date', 'text', 'photo', 'photo_url', 'message_type', 'caption', 'sticker', 'url', 'voice_url'])

/** Fields Zalo sent that its docs do not list (a quoted message, say); undefined when there are none. */
export function undocumentedFields(update: ZaloUpdate): Record<string, unknown> | undefined {
  const pick = (value: object, known: Set<string>) => Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)))
  const top = pick(update, DOCUMENTED_UPDATE)
  const inner = update.message === undefined || update.message === null ? {} : pick(update.message, DOCUMENTED_MESSAGE)
  const found = { ...top, ...(Object.keys(inner).length === 0 ? {} : { message: inner }) }
  return Object.keys(found).length === 0 ? undefined : found
}

const idString = (value: unknown) => (typeof value === 'number' ? String(value) : value)

/** Ids as strings whatever type Zalo sends them in, and the photo under `photo` whichever field carried it; an update without a message passes through for the poller to skip. */
function normalizeUpdate(update: ZaloUpdate): ZaloUpdate {
  const { message } = update
  if (message === undefined || message === null) return update
  return {
    ...update,
    message: {
      ...message,
      message_id: idString(message.message_id) as string,
      ...(message.photo === undefined && message.photo_url !== undefined ? { photo: message.photo_url } : {}),
      ...(message.from === undefined ? {} : { from: { ...message.from, id: idString(message.from.id) as string } }),
      ...(message.chat === undefined ? {} : { chat: { ...message.chat, id: idString(message.chat.id) as string } }),
    },
  }
}

/** The Bot API surface the plugin needs; tests substitute a recorder. */
export interface ZaloApi {
  getMe(): Promise<{ id: string; accountName: string; displayName?: string }>
  /** Long-polls for updates; resolves `[]` when the poll times out empty. */
  getUpdates(timeoutSec: number, signal?: AbortSignal): Promise<ZaloUpdate[]>
  sendMessage(chatId: string, text: string, options?: { parseMode?: 'markdown' }): Promise<{ messageId: string }>
  /** `sticker` is an id from stickers.zaloapp.com. */
  sendSticker(chatId: string, sticker: string): Promise<{ messageId: string }>
  sendChatAction(chatId: string, action: 'typing'): Promise<void>
  downloadUrl(url: string): Promise<Buffer>
}

export class ZaloApiError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message)
    this.name = 'ZaloApiError'
  }
}

const REQUEST_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 60_000
/** Zalo answers an empty long poll with this code. */
const POLL_TIMEOUT_CODE = 408

/** Resolves after `ms`, or rejects at once when `signal` aborts, so a stopping poller never waits out a backoff. */
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted === true) return reject(signal.reason)
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
})

/**
 * Fetches with exponential backoff on 429 and 5xx, and on network failures unless `retryThrown` is false;
 * the last attempt's outcome is returned as is.
 */
async function fetchWithRetry(retry: RetryConfig, attempt: () => Promise<Response>, signal?: AbortSignal, retryThrown = true): Promise<Response> {
  for (let n = 1; ; n++) {
    try {
      const response = await attempt()
      const transient = response.status === 429 || response.status >= 500
      if (!transient || n >= retry.maxAttempts) return response
      // Release the discarded response's connection before retrying.
      await response.body?.cancel()
    } catch (error) {
      if (!retryThrown || n >= retry.maxAttempts || signal?.aborted === true) throw error
    }
    await sleep(Math.min(retry.startDelayMs * 2 ** (n - 1), retry.maxDelayMs), signal)
  }
}

/** Reads the body, failing as soon as it grows past `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const tooLarge = () => new ZaloApiError(`download failed: larger than ${maxBytes} bytes`)
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel()
    throw tooLarge()
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > maxBytes) {
      await response.body?.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

interface Envelope<T> { ok?: boolean; result?: T; error_code?: number; description?: string }

export function createZaloApi(token: string, retry: RetryConfig, fetchImpl: typeof fetch = fetch, maxDownloadBytes = 20 * 1024 * 1024): ZaloApi {
  /** `idempotent: false` never retries a thrown error: the request may have reached Zalo before the connection failed. */
  const call = async <T>(method: string, body: object, timeoutMs = REQUEST_TIMEOUT_MS, signal?: AbortSignal, idempotent = true): Promise<T | undefined> => {
    const response = await fetchWithRetry(retry, () => fetchImpl(`${ZALO_API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    }), signal, idempotent)
    const payload = await response.json().catch(() => undefined) as Envelope<T> | undefined
    if (payload?.ok !== true) {
      throw new ZaloApiError(`${method} failed: ${payload?.description ?? `HTTP ${response.status}`}`, payload?.error_code ?? response.status)
    }
    return payload.result
  }

  return {
    async getMe() {
      const me = await call<{ id: string; account_name: string; display_name?: string }>('getMe', {})
      if (me === undefined) throw new ZaloApiError('getMe failed: no result')
      return { id: me.id, accountName: me.account_name, ...(me.display_name === undefined ? {} : { displayName: me.display_name }) }
    },
    async getUpdates(timeoutSec, signal) {
      try {
        const result = await call<ZaloUpdate | ZaloUpdate[] | null>('getUpdates', { timeout: timeoutSec }, (timeoutSec + 10) * 1000, signal)
        if (result === undefined || result === null) return []
        return (Array.isArray(result) ? result : [result]).map(normalizeUpdate)
      } catch (error) {
        if (error instanceof ZaloApiError && error.code === POLL_TIMEOUT_CODE) return []
        throw error
      }
    },
    async sendMessage(chatId, text, options = {}) {
      const sent = await call<{ message_id: string }>('sendMessage', {
        chat_id: chatId,
        text,
        ...(options.parseMode === undefined ? {} : { parse_mode: options.parseMode }),
      }, REQUEST_TIMEOUT_MS, undefined, false)
      return { messageId: sent?.message_id ?? '' }
    },
    async sendSticker(chatId, sticker) {
      const sent = await call<{ message_id: string }>('sendSticker', { chat_id: chatId, sticker }, REQUEST_TIMEOUT_MS, undefined, false)
      return { messageId: sent?.message_id ?? '' }
    },
    async sendChatAction(chatId, action) {
      await call('sendChatAction', { chat_id: chatId, action })
    },
    async downloadUrl(url) {
      const response = await fetchWithRetry(retry, () => fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }))
      if (!response.ok) throw new ZaloApiError(`download failed: HTTP ${response.status}`, response.status)
      return readCapped(response, maxDownloadBytes)
    },
  }
}
