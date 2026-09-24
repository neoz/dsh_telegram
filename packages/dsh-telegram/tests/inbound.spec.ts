import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { displayName, hasBotMention, logEntryFor, parseInbound, stripBotMention, type TelegramMessage } from '../src/inbound.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

let dir: string
let api: FakeTelegramApi
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inbound-'))
  api = new FakeTelegramApi()
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const ann = { id: 7, is_bot: false, username: 'ann', first_name: 'Ann' }
const options = () => ({ api, inboxDir: join(dir, 'inbox'), botId: 1, botUsername: 'dshbot' })

function msg(extra: Partial<TelegramMessage>, type: TelegramMessage['chat']['type'] = 'private'): TelegramMessage {
  return { message_id: 10, date: 1_700_000_000, chat: { id: 5, type }, from: ann, ...extra }
}

describe('mentions and names', () => {
  it('detects a mention entity for the bot only', () => {
    const entities = [{ type: 'mention', offset: 0, length: 7 }]
    expect(hasBotMention('@dshbot hi', entities, 'dshbot')).toBe(true)
    expect(hasBotMention('@other hi', [{ type: 'mention', offset: 0, length: 6 }], 'dshbot')).toBe(false)
    expect(hasBotMention(undefined, undefined, 'dshbot')).toBe(false)
  })
  it('strips the mention and trims', () => {
    expect(stripBotMention('@dshbot  hello', 'dshbot')).toBe('hello')
  })
  it('labels users', () => {
    expect(displayName(ann)).toBe('@ann (Ann)')
    expect(displayName({ id: 9, is_bot: false, first_name: 'Bob' })).toBe('id:9 (Bob)')
  })
  it('logEntryFor records a photo-only message', () => {
    expect(logEntryFor(msg({ photo: [{ file_id: 'p', width: 1, height: 1 }] })).text).toBe('[photo]')
  })
})

describe('parseInbound', () => {
  it('passes DM text through unchanged and logs it', async () => {
    const got = await parseInbound(msg({ text: 'hello' }), options())
    expect(got.text).toBe('hello')
    expect(got.isGroup).toBe(false)
    expect(got.logEntry).toMatchObject({ message_id: 10, user_id: 7, username: 'ann', name: 'Ann', text: 'hello' })
  })

  it('prefixes the sender label and strips the mention in groups', async () => {
    const got = await parseInbound(msg({ text: '@dshbot do it', entities: [{ type: 'mention', offset: 0, length: 7 }] }, 'supergroup'), options())
    expect(got.text).toBe('@ann (Ann): do it')
  })

  it('downloads the largest photo as an image block', async () => {
    api.files.set('big', { data: Buffer.from('jpegbytes'), filePath: 'photos/1.jpg' })
    const got = await parseInbound(msg({ caption: 'look', photo: [{ file_id: 'small', width: 1, height: 1 }, { file_id: 'big', width: 9, height: 9 }] }), options())
    expect(got.images).toEqual([{ data: Buffer.from('jpegbytes'), mediaType: 'image/jpeg' }])
    expect(got.text).toBe('look')
    expect(api.callsTo('downloadFile')[0]?.args).toEqual(['big'])
  })

  it('saves documents, voice and audio into the inbox and annotates the text', async () => {
    api.files.set('doc', { data: Buffer.from('pdf'), filePath: 'documents/x.pdf' })
    api.files.set('v', { data: Buffer.from('ogg'), filePath: 'voice/1.oga' })
    const got = await parseInbound(msg({ text: 'see', document: { file_id: 'doc', file_name: 'report.pdf' }, voice: { file_id: 'v' } }), options())
    const doc = join(dir, 'inbox', 'report.pdf')
    expect(await readFile(doc, 'utf8')).toBe('pdf')
    expect(got.savedFiles).toHaveLength(2)
    expect(got.text).toBe(`see\n[file: ${doc}]\n[voice: ${got.savedFiles[1]}]`)
    expect(got.savedFiles[1]).toMatch(/\.ogg$/)
    expect(got.logEntry.media).toEqual(got.savedFiles)
  })

  it('annotates stickers and empty messages', async () => {
    expect((await parseInbound(msg({ sticker: { emoji: ':)' } }), options())).text).toBe('[sticker: :)]')
    expect((await parseInbound(msg({}), options())).text).toBe('[empty message]')
  })

  it('prepends quoted reply context and downloads a quoted user photo but not a bot one', async () => {
    api.files.set('q', { data: Buffer.from('img'), filePath: 'photos/q.jpg' })
    const quoted: TelegramMessage = { message_id: 3, date: 1, chat: { id: 5, type: 'private' }, from: { id: 9, is_bot: false, first_name: 'Bob' }, text: 'first line\nsecond', photo: [{ file_id: 'q', width: 1, height: 1 }] }
    const got = await parseInbound(msg({ text: 'reply', reply_to_message: quoted }), options())
    expect(got.text).toBe('> id:9 (Bob): first line\n> second\n> [image]\n\nreply')
    expect(got.images).toHaveLength(1)
    expect(got.logEntry.reply_to).toBe(3)

    const botQuoted: TelegramMessage = { ...quoted, from: { id: 1, is_bot: true, first_name: 'dsh' } }
    const got2 = await parseInbound(msg({ text: 'again', reply_to_message: botQuoted }), options())
    expect(got2.images).toHaveLength(0)
    expect(got2.text.startsWith('> assistant: first line')).toBe(true)
  })

  it('saves a quoted user document, voice or audio into the inbox without logging it as own media', async () => {
    api.files.set('qd', { data: Buffer.from('pdf'), filePath: 'documents/q.pdf' })
    api.files.set('qv', { data: Buffer.from('ogg'), filePath: 'voice/q.oga' })
    const bob = { id: 9, is_bot: false, first_name: 'Bob' }
    const quoted: TelegramMessage = { message_id: 3, date: 1, chat: { id: 5, type: 'private' }, from: bob, document: { file_id: 'qd', file_name: 'report.pdf' }, voice: { file_id: 'qv' } }
    const got = await parseInbound(msg({ text: 'what is this for?', reply_to_message: quoted }), options())
    const doc = join(dir, 'inbox', 'report.pdf')
    expect(await readFile(doc, 'utf8')).toBe('pdf')
    expect(got.text).toMatch(new RegExp(`^> id:9 \\(Bob\\): \\[file: ${doc.replace(/[\\.]/g, '\\$&')}\\]\n> \\[voice: .+\\.ogg\\]\n\nwhat is this for\\?$`))
    expect(got.savedFiles).toEqual([])
    expect(got.logEntry.media).toBeUndefined()
  })

  it('does not download a document quoted from the bot', async () => {
    const botQuoted: TelegramMessage = { message_id: 3, date: 1, chat: { id: 5, type: 'private' }, from: { id: 1, is_bot: true, first_name: 'dsh' }, caption: 'answer', document: { file_id: 'bd', file_name: 'response.md' } }
    const got = await parseInbound(msg({ text: 'more', reply_to_message: botQuoted }), options())
    expect(api.callsTo('downloadFile')).toHaveLength(0)
    expect(got.text).toBe('> assistant: answer\n\nmore')
  })
})
