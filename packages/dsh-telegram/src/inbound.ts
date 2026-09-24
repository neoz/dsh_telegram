import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { ChatLogEntry } from './chatlog.ts'
import { sanitizeFilename } from './media.ts'
import type { TelegramApi } from './telegram-api.ts'

export interface TelegramUser { id: number; is_bot: boolean; username?: string; first_name: string }
interface Entity { type: string; offset: number; length: number }
/** `file_unique_id` stays the same for one file across messages and bots, unlike `file_id`. */
interface FileRef { file_id: string; file_unique_id: string }

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
  photo?: Array<FileRef & { width: number; height: number }>
  document?: FileRef & { file_name?: string; mime_type?: string }
  voice?: FileRef
  audio?: FileRef & { file_name?: string }
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

function largestPhoto(photo: TelegramMessage['photo']): FileRef | undefined {
  if (photo === undefined || photo.length === 0) return undefined
  return photo.reduce((best, p) => (p.width * p.height > best.width * best.height ? p : best))
}

/** Saves the file to `inbox/<file_unique_id>/<name>`; a file already there is reused and its mtime refreshed for retention. */
async function saveInbox(api: TelegramApi, inboxDir: string, file: FileRef, preferredName: string | undefined, fallbackExt: string): Promise<string> {
  const dir = join(inboxDir, sanitizeFilename(file.file_unique_id, ''))
  const [existing] = await readdir(dir).catch(() => [])
  if (existing !== undefined) {
    const path = join(dir, existing)
    const now = new Date()
    await utimes(path, now, now)
    return path
  }
  const { data, filePath } = await api.downloadFile(file.file_id)
  const ext = fallbackExt === '' ? extname(filePath) : fallbackExt
  await mkdir(dir, { recursive: true })
  const target = join(dir, sanitizeFilename(preferredName, ext))
  await writeFile(target, data)
  return target
}

async function loadPhoto(api: TelegramApi, inboxDir: string, photo: FileRef): Promise<InboundImage> {
  const path = await saveInbox(api, inboxDir, photo, 'photo.jpg', '.jpg')
  return { data: await readFile(path), mediaType: 'image/jpeg' }
}

/** Saves the message's document, voice and audio into the inbox; returns the paths and their text markers. */
async function saveMedia(message: TelegramMessage, api: TelegramApi, inboxDir: string): Promise<{ paths: string[]; markers: string[] }> {
  const paths: string[] = []
  const markers: string[] = []
  const save = async (kind: string, file: FileRef, name: string | undefined, fallbackExt: string) => {
    const path = await saveInbox(api, inboxDir, file, name, fallbackExt)
    paths.push(path)
    markers.push(`[${kind}: ${path}]`)
  }
  if (message.document !== undefined) await save('file', message.document, message.document.file_name, '')
  if (message.voice !== undefined) await save('voice', message.voice, undefined, '.ogg')
  if (message.audio !== undefined) await save('audio', message.audio, message.audio.file_name, '.mp3')
  return { paths, markers }
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

  const photo = largestPhoto(message.photo)
  if (photo !== undefined) images.push(await loadPhoto(options.api, options.inboxDir, photo))
  const media = await saveMedia(message, options.api, options.inboxDir)
  savedFiles.push(...media.paths)
  parts.push(...media.markers)
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
      images.push(await loadPhoto(options.api, options.inboxDir, quotedPhoto))
      quotedText = quotedText === '' ? '[image]' : `${quotedText}\n[image]`
    }
    if (!fromBot) {
      const quotedMedia = await saveMedia(quoted, options.api, options.inboxDir)
      quotedText = [quotedText, ...quotedMedia.markers].filter(t => t !== '').join('\n')
    }
    const label = fromBot ? 'assistant' : displayName(quoted.from)
    const block = quotedText.split('\n').map((line, i) => (i === 0 ? `> ${label}: ${line}` : `> ${line}`)).join('\n')
    text = `${block}\n\n${text}`
  }

  return { chatId: message.chat.id, messageId: message.message_id, isGroup, sender, text, images, savedFiles, logEntry: logEntryFor(message, savedFiles) }
}
