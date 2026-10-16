import { describe, expect, it, vi } from 'vitest'
import { createZaloChannel, startTyping } from '../src/channel.ts'
import { Config } from '../src/config.ts'
import { ZaloApiError } from '../src/zalo-api.ts'
import { FakeZaloApi } from './helpers/fake-api.ts'

const log = { warn: vi.fn(), error: vi.fn() }
const config = Config({ botToken: 't' })
function channel(api: FakeZaloApi, extra: Partial<Config> = {}) {
  return createZaloChannel({ api, bot: { id: 'bot1', accountName: 'dshbot' }, config: { ...config, typingIntervalMs: 60_000, ...extra }, log })
}
const reply = (text: string) => ({ kind: 'reply' as const, text, timeoutMs: 60_000 })
const sent = (api: FakeZaloApi) => api.callsTo('sendMessage').map(c => c.args[1])

async function deliverOnce(api: FakeZaloApi, report: Parameters<Awaited<ReturnType<ReturnType<typeof channel>['openTurn']>>['deliver']>[0], extra: Partial<Config> = {}) {
  const sink = await channel(api, extra).openTurn('c1', {})
  try {
    return await sink.deliver(report)
  } finally {
    sink.close()
  }
}

describe('Zalo turn sink', () => {
  it('shows typing and sends the reply as markdown', async () => {
    const api = new FakeZaloApi()
    expect(await deliverOnce(api, reply('**hi**'))).toEqual({ outcome: 'sent', messageId: 'm100' })
    expect(api.callsTo('sendChatAction')[0]!.args).toEqual(['c1', 'typing'])
    expect(api.callsTo('sendMessage')[0]!.args).toEqual(['c1', '**hi**', { parseMode: 'markdown' }])
  })

  it('stops typing once the reply is delivered', async () => {
    vi.useFakeTimers()
    const api = new FakeZaloApi()
    await deliverOnce(api, reply('ok'), { typingIntervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.callsTo('sendChatAction')).toHaveLength(1)
    vi.useRealTimers()
  })

  it('sends a long reply as ordered chunks within messageSize', async () => {
    const api = new FakeZaloApi()
    await deliverOnce(api, reply(`${'a'.repeat(400)}\n\n${'b'.repeat(400)}`), { messageSize: 500 })
    expect(sent(api)).toEqual(['a'.repeat(400), 'b'.repeat(400)])
  })

  it('resends a chunk Zalo rejects as plain text', async () => {
    const api = new FakeZaloApi()
    api.failNext('sendMessage', new ZaloApiError('sendMessage failed: bad markdown', 400))
    expect((await deliverOnce(api, reply('| a | b |'))).outcome).toBe('sent')
    expect(api.callsTo('sendMessage').map(c => c.args[2])).toEqual([{ parseMode: 'markdown' }, undefined])
  })

  it('reports undelivered when plain text fails too', async () => {
    const api = new FakeZaloApi()
    api.failNext('sendMessage', new ZaloApiError('a', 400))
    api.failNext('sendMessage', new ZaloApiError('b', 400))
    expect((await deliverOnce(api, reply('x'))).outcome).toBe('undelivered')
    expect(log.error).toHaveBeenCalled()
  })

  it('does not resend as plain text after a network error, so the user never gets the reply twice', async () => {
    const api = new FakeZaloApi()
    api.failNext('sendMessage', new TypeError('fetch failed'))
    expect((await deliverOnce(api, reply('x'))).outcome).toBe('undelivered')
    expect(api.callsTo('sendMessage')).toHaveLength(1)
  })

  it('still replies when typing fails', async () => {
    const api = new FakeZaloApi()
    api.failNext('sendChatAction', new Error('nope'))
    expect((await deliverOnce(api, reply('ok'))).outcome).toBe('sent')
  })

  it('maps error, stopped, empty and timeout to short notices', async () => {
    const api = new FakeZaloApi()
    expect((await deliverOnce(api, { kind: 'error', text: '', error: 'E: boom', timeoutMs: 60_000 })).outcome).toBe('error')
    expect((await deliverOnce(api, { kind: 'stopped', text: '', timeoutMs: 60_000 })).outcome).toBe('stopped')
    expect((await deliverOnce(api, { kind: 'empty', text: '', timeoutMs: 60_000 })).outcome).toBe('empty')
    expect((await deliverOnce(api, { kind: 'timeout', text: '', timeoutMs: 60_000 })).outcome).toBe('timeout')
    expect(sent(api)).toEqual(['Error: E: boom', 'Stopped.', '(no reply)', 'The reply timed out after 60s and was stopped.'])
  })
})

describe('Zalo send and react', () => {
  it('sends plainly; a reply target is a fallback since Zalo cannot quote', async () => {
    const api = new FakeZaloApi()
    expect(await channel(api).send('c1', 'hi')).toEqual({ as: 'native', messageId: 'm100', text: 'hi' })
    expect(await channel(api).send('c1', 'yo', { replyTo: 'm1' })).toEqual({ as: 'fallback', messageId: 'm101', text: 'yo' })
    expect(api.callsTo('sendMessage').map(c => c.args)).toEqual([['c1', 'hi', undefined], ['c1', 'yo', undefined]])
  })

  it('reacts by posting the emoji as text', async () => {
    const api = new FakeZaloApi()
    expect(await channel(api).react('c1', 'm1', '\u{1F44D}')).toEqual({ as: 'fallback', messageId: 'm100', text: '\u{1F44D}' })
  })
})

describe('startTyping', () => {
  it('repeats until stopped', async () => {
    vi.useFakeTimers()
    const api = new FakeZaloApi()
    const stop = startTyping(api, 'c1', 4000, log)
    await vi.advanceTimersByTimeAsync(8100)
    stop()
    await vi.advanceTimersByTimeAsync(8000)
    expect(api.callsTo('sendChatAction')).toHaveLength(3)
    vi.useRealTimers()
  })
})
