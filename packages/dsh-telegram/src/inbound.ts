import { mkdir, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { ChatLogEntry } from './chatlog.ts'
import { sanitizeFilename, uniquePath } from './media.ts'
import type { TelegramApi } from './telegram-api.ts'

export interface TelegramUser { id: number; is_bot: boolean; username?: string; first_name: string }
interface Entity { type: string; offset: number; length: number }

/** The subset of a Telegram message the parser reads; grammY's Message satisfies it structurally. */
export interface TelegramMessage {
  message_id: number
  date: number
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' }
  from?: TelegramUser
  text?: string
  caption?: string
  entities?: Entity[]
  caption_entities?: Entity[]
  photo?: Array<{ file_id: string; width: number; height: number }>
  document?: { file_id: string; file_name?: string; mime_type?: string }
  voice?: { file_id: string }
  audio?: { file_id: string; file_name?: string }
  sticker?: { emoji?: string }
  reply_to_message?: TelegramMessage
}

export interface InboundImage { data: Buffer; mediaType: 'image/jpeg' }

export interface InboundMessage {
  chatId: number
  messageId: number
  isGroup: boolean
  sender: TelegramUser
  text: string
  images: InboundImage[]
  savedFiles: string[]
  logEntry: ChatLogEntry
}

export interface ParseOptions { api: TelegramApi; inboxDir: string; botId: number; botUsername: string }

export function hasBotMention(text: string | undefined, entities: Entity[] | undefined, botUsername: string): boolean {
  if (text === undefined || entities === undefined) return false
  const wanted = `@${botUsername}`.toLowerCase()
  return entities.some(e => e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === wanted)
}

export function stripBotMention(text: string, botUsername: string): string {
  return text.replaceAll(new RegExp(`@${botUsername}`, 'gi'), '').replace(/[ \t]+/g, ' ').trim()
}

export function displayName(user: TelegramUser): string {
  if (user.is_bot) return 'assistant'
  const base = user.username === undefined ? `id:${user.id}` : `@${user.username}`
  return user.first_name === '' ? base : `${base} (${user.first_name})`
}

function bodyText(message: TelegramMessage): string {
  return [message.text, message.caption].filter((t): t is string => t !== undefined && t !== '').join('\n')
}

function largestPhoto(photo: TelegramMessage['photo']): string | undefined {
  if (photo === undefined || photo.length === 0) return undefined
  return photo.reduce((best, p) => (p.width * p.height > best.width * best.height ? p : best)).file_id
}

async function saveInbox(api: TelegramApi, inboxDir: string, fileId: string, preferredName: string | undefined, fallbackExt: string): Promise<string> {
  const { data, filePath } = await api.downloadFile(fileId)
  const ext = fallbackExt === '' ? extname(filePath) : fallbackExt
  await mkdir(inboxDir, { recursive: true })
  const target = await uniquePath(inboxDir, sanitizeFilename(preferredName, ext))
  await writeFile(target, data)
  return target
}

/** Chat-log record for any observed message; `savedFiles` lists inbox paths when media was downloaded. */
export function logEntryFor(message: TelegramMessage, savedFiles: string[] = []): ChatLogEntry {
  const sender = message.from
  if (sender === undefined) throw new Error('message without sender')
  const text = bodyText(message)
  return {
    ts: new Date(message.date * 1000).toISOString(),
    message_id: message.message_id,
    user_id: sender.id,
    ...(sender.username === undefined ? {} : { username: sender.username }),
    name: sender.first_name,
    text: text !== '' ? text : message.sticker !== undefined ? '[sticker]' : message.photo !== undefined ? '[photo]' : '',
    ...(message.reply_to_message === undefined ? {} : { reply_to: message.reply_to_message.message_id }),
    ...(savedFiles.length === 0 ? {} : { media: savedFiles }),
  }
}

export async function parseInbound(message: TelegramMessage, options: ParseOptions): Promise<InboundMessage> {
  const sender = message.from
  if (sender === undefined) throw new Error('message without sender')
  const isGroup = message.chat.type !== 'private'
  const images: InboundImage[] = []
  const savedFiles: string[] = []
  const parts: string[] = []

  let body = bodyText(message)
  if (isGroup) body = stripBotMention(body, options.botUsername)
  if (body !== '') parts.push(body)

  const photoId = largestPhoto(message.photo)
  if (photoId !== undefined) {
    const { data } = await options.api.downloadFile(photoId)
    images.push({ data, mediaType: 'image/jpeg' })
  }
  if (message.document !== undefined) {
    const path = await saveInbox(options.api, options.inboxDir, message.document.file_id, message.document.file_name, '')
    savedFiles.push(path)
    parts.push(`[file: ${path}]`)
  }
  if (message.voice !== undefined) {
    const path = await saveInbox(options.api, options.inboxDir, message.voice.file_id, undefined, '.ogg')
    savedFiles.push(path)
    parts.push(`[voice: ${path}]`)
  }
  if (message.audio !== undefined) {
    const path = await saveInbox(options.api, options.inboxDir, message.audio.file_id, message.audio.file_name, '.mp3')
    savedFiles.push(path)
    parts.push(`[audio: ${path}]`)
  }
  if (message.sticker !== undefined) {
    parts.push(message.sticker.emoji === undefined ? '[sticker]' : `[sticker: ${message.sticker.emoji}]`)
  }

  let text = parts.join('\n')
  if (text === '') text = '[empty message]'
  if (isGroup) text = `${displayName(sender)}: ${text}`

  const quoted = message.reply_to_message
  if (quoted?.from !== undefined) {
    const fromBot = quoted.from.id === options.botId
    let quotedText = quoted.text ?? quoted.caption ?? ''
    const quotedPhoto = fromBot ? undefined : largestPhoto(quoted.photo)
    if (quotedPhoto !== undefined) {
      const { data } = await options.api.downloadFile(quotedPhoto)
      images.push({ data, mediaType: 'image/jpeg' })
      quotedText = quotedText === '' ? '[image]' : `${quotedText}\n[image]`
    }
    const label = fromBot ? 'assistant' : displayName(quoted.from)
    const block = quotedText.split('\n').map((line, i) => (i === 0 ? `> ${label}: ${line}` : `> ${line}`)).join('\n')
    text = `${block}\n\n${text}`
  }

  return { chatId: message.chat.id, messageId: message.message_id, isGroup, sender, text, images, savedFiles, logEntry: logEntryFor(message, savedFiles) }
}
