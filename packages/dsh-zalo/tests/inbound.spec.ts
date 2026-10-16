import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bodyText, hasTrigger, logEntryFor, parseInbound, stripTrigger, toInbound } from '../src/inbound.ts'
import type { ZaloUpdate } from '../src/zalo-api.ts'
import { FakeZaloApi } from './helpers/fake-api.ts'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])
const trig = { accountName: 'DshBot', groupPrefix: '/ask' }
function upd(event: string, extra: Record<string, unknown>, chatType: 'PRIVATE' | 'GROUP' = 'PRIVATE'): ZaloUpdate {
  return {
    event_name: `message.${event}.received`,
    message: { message_id: 'mid1', date: Date.UTC(2026, 9, 15, 5), from: { id: 'u1', display_name: 'Ann' }, chat: { id: 'c1', chat_type: chatType }, ...extra },
  }
}

let dir: string
let api: FakeZaloApi
const log = { warn: vi.fn() }
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'inbound-')); api = new FakeZaloApi() })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('triggers', () => {
  it('matches a mention anywhere, case-insensitively, and a leading prefix word', () => {
    expect(hasTrigger('hey @dshbot what', trig)).toBe(true)
    expect(hasTrigger('/ask what', trig)).toBe(true)
    expect(hasTrigger('/ask', trig)).toBe(true)
    expect(hasTrigger('/asking what', trig)).toBe(false)
    expect(hasTrigger('plain talk', trig)).toBe(false)
  })
  it('matches the display name Zalo inserts for a mention, as seen in a real group', () => {
    const named = { ...trig, displayName: 'Bot Trợ Lý SI' }
    expect(hasTrigger('chào @Bot Trợ Lý SI', named)).toBe(true)
    expect(stripTrigger('chào @Bot Trợ Lý SI', named)).toBe('chào')
    expect(hasTrigger('chào @Bot Trợ Lý', named)).toBe(false)
  })
  it('strips the mention and the prefix', () => {
    expect(stripTrigger('hey @DSHBOT  what', trig)).toBe('hey what')
    expect(stripTrigger('/ask what is up', trig)).toBe('what is up')
  })
})

describe('bodyText / logEntryFor', () => {
  it('joins text and caption and logs markers for non-text events', () => {
    expect(bodyText(upd('image', { photo: 'https://p', caption: 'look' }).message)).toBe('look')
    expect(logEntryFor(upd('sticker', { sticker: 's1' })).text).toBe('[sticker]')
    expect(logEntryFor(upd('voice', { voice_url: 'https://v' })).text).toBe('[voice]')
    expect(logEntryFor(upd('unsupported', {})).text).toBe('[unsupported message]')
    expect(logEntryFor(upd('image', { photo: 'https://p' })).text).toBe('[photo]')
  })
  it('stamps ts from the Zalo date in ms', () => {
    expect(logEntryFor(upd('text', { text: 'hi' }))).toEqual({
      ts: '2026-10-15T05:00:00.000Z', message_id: 'mid1', user_id: 'u1', name: 'Ann', text: 'hi',
    })
  })
})

describe('parseInbound', () => {
  it('parses a text message and strips the group trigger', async () => {
    const parsed = await parseInbound(upd('text', { text: '@dshbot hello' }, 'GROUP'), { ...trig, api, inboxDir: dir, log })
    expect(parsed).toMatchObject({ chatId: 'c1', messageId: 'mid1', isGroup: true, text: 'hello', images: [] })
  })

  it('strips the trigger for a group whatever the case of its chat type', async () => {
    const parsed = await parseInbound(upd('text', { text: '@dshbot hello' }, 'group' as never), { ...trig, api, inboxDir: dir, log })
    expect(parsed).toMatchObject({ isGroup: true, text: 'hello' })
  })

  it('downloads a photo, sniffs its type and saves it in the inbox', async () => {
    api.downloads.set('https://p', JPEG)
    const parsed = await parseInbound(upd('image', { photo: 'https://p', caption: 'look' }), { ...trig, api, inboxDir: dir, log })
    expect(parsed.images).toEqual([{ data: JPEG, mediaType: 'image/jpeg' }])
    expect(parsed.text).toBe('look')
    expect(await readdir(dir)).toEqual(['mid1.jpg'])
    expect(parsed.logEntry.media).toEqual([join(dir, 'mid1.jpg')])
  })

  it('still yields a turn with a marker when the photo download fails', async () => {
    const parsed = await parseInbound(upd('image', { photo: 'https://gone' }), { ...trig, api, inboxDir: dir, log })
    expect(parsed.images).toEqual([])
    expect(parsed.text).toBe('[image could not be downloaded]')
    expect(log.warn).toHaveBeenCalled()
  })

  it('rejects bytes that are not an image', async () => {
    api.downloads.set('https://p', Buffer.from('<html>'))
    const parsed = await parseInbound(upd('image', { photo: 'https://p' }), { ...trig, api, inboxDir: dir, log })
    expect(parsed.images).toEqual([])
    expect(parsed.text).toBe('[image could not be downloaded]')
  })

  it('turns a sticker into a marker the agent can read', async () => {
    const parsed = await parseInbound(upd('sticker', { sticker: 's1' }), { ...trig, api, inboxDir: dir, log })
    expect(parsed.text).toBe('[sticker]')
  })
})

describe('toInbound', () => {
  const deps = () => ({ ...trig, displayName: 'Dsh Bot', api, botId: 'bot1', inboxFor: () => join(dir, 'inbox'), log })

  it('drops bots and the bot itself', () => {
    expect(toInbound(upd('text', { text: 'hi', from: { id: 'bot1' } }), deps())).toBeUndefined()
    expect(toInbound(upd('text', { text: 'hi', from: { id: 'x', is_bot: true } }), deps())).toBeUndefined()
  })

  it('keys the chat and keeps the sender channel-neutral', () => {
    expect(toInbound(upd('text', { text: 'hi' }), deps())).toMatchObject({
      chatKey: 'zalo:c1', messageId: 'mid1', sender: { id: 'u1', name: 'Ann' }, isGroup: false, addressed: true, at: Date.UTC(2026, 9, 15, 5),
    })
  })

  it('addresses a group message by mention or prefix and strips the trigger', () => {
    expect(toInbound(upd('text', { text: 'hi' }, 'GROUP'), deps())!.addressed).toBe(false)
    expect(toInbound(upd('text', { text: '@Dsh Bot /reset' }, 'GROUP'), deps())).toMatchObject({ addressed: true, text: '/reset' })
    expect(toInbound(upd('text', { text: '/ask what' }, 'GROUP'), deps())).toMatchObject({ addressed: true, text: 'what' })
  })

  it('loads only the log line in log mode and the turn text in turn mode', async () => {
    const m = toInbound(upd('text', { text: 'hi' }, 'GROUP'), deps())!
    expect(await m.load('log')).toMatchObject({ logEntry: { message_id: 'mid1', text: 'hi' }, text: '', images: [] })
    expect((await m.load('turn')).text).toBe('hi')
  })
})
