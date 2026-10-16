import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACK_REACTION, createTelegramChannel, type TelegramChannelDeps } from '../src/channel.ts'
import { Config } from '../src/config.ts'
import { UNDELIVERED_NOTICE, UTF8_BOM } from '../src/render.ts'
import { TelegramApiError } from '../src/telegram-api.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

let dir: string
let api: FakeTelegramApi
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'channel-')); api = new FakeTelegramApi() })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const config = Config({ botToken: 't' })
const channel = (log: TelegramChannelDeps['log'] = { warn: () => {}, error: () => {} }) => createTelegramChannel({
  api, bot: { id: 1, username: 'dshbot' }, config: { ...config, statusEditIntervalMs: 0 },
  outboxFor: () => join(dir, 'outbox'), log,
})
const reply = (text: string) => ({ kind: 'reply' as const, text, timeoutMs: 10_000 })
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

describe('Telegram turn sink', () => {
  it('acks the message, shows typing and a reply placeholder, then edits it into the answer', async () => {
    const sink = await channel().openTurn('5', { replyTo: '10' })
    expect(api.callsTo('setReaction')[0]!.args).toEqual([5, 10, ACK_REACTION])
    expect(api.callsTo('sendChatAction')).toHaveLength(1)
    expect(api.callsTo('sendMessage')[0]!.args).toEqual([5, 'Thinking...', { replyTo: { messageId: 10 } }])
    const delivered = await sink.deliver(reply('**done**'))
    sink.close()
    expect(delivered).toEqual({ outcome: 'edited', messageId: '100' })
    expect(api.callsTo('editMessageText').at(-1)!.args).toEqual([5, 100, '<b>done</b>', { parseMode: 'HTML' }])
  })

  it('a prompt turn neither acks nor quotes', async () => {
    const sink = await channel().openTurn('5', {})
    await sink.deliver(reply('ok'))
    sink.close()
    expect(api.callsTo('setReaction')).toHaveLength(0)
    expect(api.callsTo('sendMessage')[0]!.args[2]).toEqual({})
  })

  it('still answers when the ack reaction or typing fails', async () => {
    const warns: string[] = []
    api.failNext('setReaction', new Error('reactions off'))
    api.failNext('sendChatAction', new Error('typing down'))
    const sink = await channel({ warn: m => warns.push(m), error: () => {} }).openTurn('5', { replyTo: '10' })
    expect((await sink.deliver(reply('ok'))).outcome).toBe('edited')
    sink.close()
    expect(warns.some(w => w.includes('reactions off'))).toBe(true)
    expect(warns.some(w => w.includes('typing down'))).toBe(true)
  })

  it('edits the placeholder with group labels and skips repeats', async () => {
    const sink = await channel().openTurn('5', { replyTo: '10' })
    sink.status('bash')
    await tick()
    sink.status('bash')
    await tick()
    sink.status('read')
    await tick()
    await sink.deliver(reply('ok'))
    sink.close()
    expect(api.callsTo('editMessageText').map(c => c.args[2])).toEqual(['Running a command...', 'Reading files...', 'ok'])
  })

  it('sends fresh when the placeholder edit fails', async () => {
    const sink = await channel().openTurn('5', { replyTo: '10' })
    api.failNext('editMessageText', new TelegramApiError('message to edit not found', 400))
    expect((await sink.deliver(reply('answer'))).outcome).toBe('sent')
    sink.close()
    expect(api.callsTo('deleteMessage')[0]?.args).toEqual([5, 100])
    expect(api.callsTo('sendMessage').at(-1)!.args[1]).toBe('answer')
  })

  it('retries a rejected send without the collapse wrapper, then as plain text', async () => {
    const sink = await channel().openTurn('5', { replyTo: '10' })
    api.failNext('editMessageText', new TelegramApiError("can't parse entities", 400))
    api.failNext('sendMessage', new TelegramApiError("can't parse entities", 400))
    api.failNext('sendMessage', new TelegramApiError("can't parse entities", 400))
    expect((await sink.deliver(reply('word '.repeat(400)))).outcome).toBe('sent')
    sink.close()
    const sends = api.callsTo('sendMessage').slice(1)
    expect(sends).toHaveLength(3)
    expect(sends[0]!.args[1]).toContain('<blockquote expandable>')
    expect(sends[1]!.args[1]).not.toContain('<blockquote expandable>')
    expect(sends[2]!.args[2]).toEqual({ replyTo: { messageId: 10 } })
  })

  it('sends a markdown document when the rendered message exceeds 4096 bytes', async () => {
    const long = 'line of text that is long enough\n'.repeat(200)
    const sink = await channel().openTurn('5', { replyTo: '10' })
    const delivered = await sink.deliver(reply(long))
    sink.close()
    expect(delivered.outcome).toBe('document')
    expect(api.callsTo('deleteMessage')[0]?.args).toEqual([5, 100])
    const [, data, opts] = api.callsTo('sendDocument')[0]!.args as [number, Buffer, { filename: string; caption: string; replyTo: object }]
    expect(data.toString('utf8')).toBe(UTF8_BOM + long)
    expect(opts.filename).toMatch(/^response-\d+\.md$/)
    expect(Buffer.byteLength(opts.caption)).toBeLessThanOrEqual(1024)
    expect(opts.replyTo).toEqual({ messageId: 10 })
    expect(await readdir(join(dir, 'outbox'))).toHaveLength(1)
  })

  it('reports undelivered when the document upload fails, without a truncated fallback', async () => {
    const sink = await channel().openTurn('5', { replyTo: '10' })
    api.failNext('sendDocument', new TelegramApiError('too big', 413))
    const delivered = await sink.deliver(reply('x'.repeat(5000)))
    sink.close()
    expect(delivered).toEqual({ outcome: 'undelivered' })
    expect(api.callsTo('sendMessage').at(-1)!.args[1]).toBe(UNDELIVERED_NOTICE)
    expect(api.callsTo('sendMessage')).toHaveLength(2)
  })

  it('replaces the placeholder with error, timeout, stopped and empty notices', async () => {
    const cases = [
      [{ kind: 'error', text: '', error: 'LLM_AUTH: bad key', timeoutMs: 10_000 }, 'error', 'Error: LLM_AUTH: bad key'],
      [{ kind: 'timeout', text: '', timeoutMs: 10_000 }, 'timeout', 'The reply timed out after 10s and was stopped.'],
      [{ kind: 'stopped', text: '', timeoutMs: 10_000 }, 'stopped', 'Stopped.'],
      [{ kind: 'empty', text: '', timeoutMs: 10_000 }, 'empty', '(no reply)'],
    ] as const
    for (const [report, outcome, shown] of cases) {
      const sink = await channel().openTurn('5', { replyTo: '10' })
      expect((await sink.deliver(report)).outcome).toBe(outcome)
      sink.close()
      expect(api.callsTo('editMessageText').at(-1)!.args[2]).toBe(shown)
    }
  })
})

describe('Telegram send and react', () => {
  it('sends natively, quoting when asked', async () => {
    expect(await channel().send('5', 'hi', { replyTo: '10' })).toEqual({ as: 'native', messageId: '100', text: 'hi' })
    expect(api.callsTo('sendMessage')[0]!.args).toEqual([5, 'hi', { replyTo: { messageId: 10 } }])
  })

  it('reacts natively and posts nothing', async () => {
    expect(await channel().react('5', '10', '\u{1F44D}')).toEqual({ as: 'native' })
    expect(api.callsTo('setReaction')[0]!.args).toEqual([5, 10, '\u{1F44D}'])
  })
})
