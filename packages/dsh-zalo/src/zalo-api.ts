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
  photo?: string
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

const idString = (value: unknown) => (typeof value === 'number' ? String(value) : value)

/** Ids as strings whatever type Zalo sends them in; an update without a message passes through for the poller to skip. */
function normalizeUpdate(update: ZaloUpdate): ZaloUpdate {
  const { message } = update
  if (message === undefined || message === null) return update
  return {
    ...update,
    message: {
      ...message,
      message_id: idString(message.message_id) as string,
      ...(message.from === undefined ? {} : { from: { ...message.from, id: idString(message.from.id) as string } }),
      ...(message.chat === undefined ? {} : { chat: { ...message.chat, id: idString(message.chat.id) as string } }),
    },
  }
}

/** The Bot API surface the plugin needs; tests substitute a recorder. */
export interface ZaloApi {
  getMe(): Promise<{ id: string; accountName: string }>
  /** Long-polls for updates; resolves `[]` when the poll times out empty. */
  getUpdates(timeoutSec: number, signal?: AbortSignal): Promise<ZaloUpdate[]>
  sendMessage(chatId: string, text: string, options?: { parseMode?: 'markdown' }): Promise<{ messageId: string }>
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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
    await sleep(Math.min(retry.startDelayMs * 2 ** (n - 1), retry.maxDelayMs))
  }
}

interface Envelope<T> { ok?: boolean; result?: T; error_code?: number; description?: string }

export function createZaloApi(token: string, retry: RetryConfig, fetchImpl: typeof fetch = fetch): ZaloApi {
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
      const me = await call<{ id: string; account_name: string }>('getMe', {})
      if (me === undefined) throw new ZaloApiError('getMe failed: no result')
      return { id: me.id, accountName: me.account_name }
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
    async sendChatAction(chatId, action) {
      await call('sendChatAction', { chat_id: chatId, action })
    },
    async downloadUrl(url) {
      const response = await fetchWithRetry(retry, () => fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }))
      if (!response.ok) throw new ZaloApiError(`download failed: HTTP ${response.status}`, response.status)
      return Buffer.from(await response.arrayBuffer())
    },
  }
}
