import { describe, expect, it, vi } from 'vitest'
import { createZaloApi, ZaloApiError } from '../src/zalo-api.ts'

const retry = { maxAttempts: 3, startDelayMs: 0, maxDelayMs: 0 }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('createZaloApi', () => {
  it('posts JSON to the bot URL and unwraps result', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, result: { message_id: 'm1', date: 1 } }))
    const api = createZaloApi('TOKEN', retry, fetchImpl as never)
    expect(await api.sendMessage('c1', 'hi', { parseMode: 'markdown' })).toEqual({ messageId: 'm1' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://bot-api.zaloplatforms.com/botTOKEN/sendMessage')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: 'c1', text: 'hi', parse_mode: 'markdown' })
  })

  it('maps getMe fields', async () => {
    const api = createZaloApi('T', retry, (async () => json({ ok: true, result: { id: 'b1', account_name: 'dshbot' } })) as never)
    expect(await api.getMe()).toEqual({ id: 'b1', accountName: 'dshbot' })
  })

  it('normalises getUpdates to an array', async () => {
    const update = { event_name: 'message.text.received', message: { message_id: 'x' } }
    const one = createZaloApi('T', retry, (async () => json({ ok: true, result: update })) as never)
    expect(await one.getUpdates(30)).toEqual([update])
    const many = createZaloApi('T', retry, (async () => json({ ok: true, result: [update, update] })) as never)
    expect(await many.getUpdates(30)).toHaveLength(2)
    const none = createZaloApi('T', retry, (async () => json({ ok: true })) as never)
    expect(await none.getUpdates(30)).toEqual([])
  })

  it('turns numeric ids into strings, since Zalo docs disagree on their type', async () => {
    const raw = { event_name: 'message.text.received', message: { message_id: 7, from: { id: 8 }, chat: { id: 9, chat_type: 'PRIVATE' }, date: 1 } }
    const api = createZaloApi('T', retry, (async () => json({ ok: true, result: raw })) as never)
    const [update] = await api.getUpdates(30)
    expect(update!.message).toMatchObject({ message_id: '7', from: { id: '8' }, chat: { id: '9' } })
  })

  it('treats a 408 long-poll timeout as no updates', async () => {
    const api = createZaloApi('T', retry, (async () => json({ ok: false, error_code: 408, description: 'Request timeout' })) as never)
    expect(await api.getUpdates(30)).toEqual([])
  })

  it('retries idempotent calls on 5xx and network errors, then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json({}, 502))
      .mockResolvedValueOnce(json({ ok: true, result: { id: 'b1', account_name: 'dshbot' } }))
    const api = createZaloApi('T', retry, fetchImpl as never)
    expect(await api.getMe()).toEqual({ id: 'b1', accountName: 'dshbot' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('retries sendMessage when Zalo answers 5xx, since nothing was delivered', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ ok: true, result: { message_id: 'm2' } }))
    const api = createZaloApi('T', retry, fetchImpl as never)
    expect(await api.sendMessage('c', 'x')).toEqual({ messageId: 'm2' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('never resends a message after a network error, since Zalo may already have delivered it', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const api = createZaloApi('T', retry, fetchImpl as never)
    await expect(api.sendMessage('c', 'x')).rejects.toThrow('fetch failed')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('throws ZaloApiError on ok:false without leaking the token', async () => {
    const api = createZaloApi('SECRET', retry, (async () => json({ ok: false, error_code: 400, description: 'bad text' })) as never)
    const error = await api.sendMessage('c', 'x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ZaloApiError)
    expect((error as ZaloApiError).code).toBe(400)
    expect(String((error as Error).message)).toBe('sendMessage failed: bad text')
    expect(String((error as Error).message)).not.toContain('SECRET')
  })

  it('downloads a URL with retry and rejects non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('x', { status: 503 })).mockResolvedValueOnce(new Response('abc'))
    const api = createZaloApi('T', retry, fetchImpl as never)
    expect((await api.downloadUrl('https://img')).toString()).toBe('abc')
    const missing = createZaloApi('T', retry, (async () => new Response('', { status: 404 })) as never)
    await expect(missing.downloadUrl('https://img')).rejects.toThrow(/HTTP 404/)
  })
})
