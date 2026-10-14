import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from 'grammy'
import { createGrammyApi } from '../src/telegram-api.ts'

const retry = { maxAttempts: 3, startDelayMs: 0, maxDelayMs: 0, maxUploadMb: 20 }
const bot = { api: { getFile: async () => ({ file_path: 'photos/a.jpg' }) } } as unknown as Bot

afterEach(() => { vi.unstubAllGlobals() })

describe('downloadFile', () => {
  it('retries a failed fetch until the download succeeds', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('busy', { status: 502 }))
      .mockResolvedValueOnce(new Response('img'))
    vi.stubGlobal('fetch', fetch)
    const file = await createGrammyApi(bot, 'T', retry).downloadFile('f')
    expect(file.data.toString()).toBe('img')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('cancels the body of a response it retries past', async () => {
    const busy = new Response('busy', { status: 503 })
    const cancel = vi.spyOn(busy.body!, 'cancel')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(busy).mockResolvedValueOnce(new Response('img')))
    await createGrammyApi(bot, 'T', retry).downloadFile('f')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('gives up after the last attempt', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetch)
    await expect(createGrammyApi(bot, 'T', retry).downloadFile('f')).rejects.toThrow('fetch failed')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('does not retry a client error', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('gone', { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    await expect(createGrammyApi(bot, 'T', retry).downloadFile('f')).rejects.toThrow('download failed: 404')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
