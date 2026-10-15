import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatLogEntry } from './chatlog.ts'
import { extensionFor, pathSafe, sniffImageType, type ImageMediaType } from './media.ts'
import { isGroupChat, type ZaloApi, type ZaloMessage, type ZaloUpdate, type ZaloUser } from './zalo-api.ts'

export interface InboundImage { data: Buffer; mediaType: ImageMediaType }

export interface InboundMessage {
  chatId: string
  messageId: string
  isGroup: boolean
  sender: ZaloUser
  text: string
  images: InboundImage[]
  logEntry: ChatLogEntry
}

/** Zalo writes a mention as `@` plus the bot's display name; `@accountName` is accepted too. */
export interface TriggerOptions { accountName: string; displayName?: string; groupPrefix: string }

const DOWNLOAD_FAILED = '[image could not be downloaded]'

/** Text shown for events that carry no text of their own. */
const MARKERS: Record<string, string> = {
  'message.image.received': '[photo]',
  'message.sticker.received': '[sticker]',
  'message.voice.received': '[voice]',
  'message.unsupported.received': '[unsupported message]',
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The longer name is tried first, so a display name with spaces is matched whole. */
const mentionPattern = (options: TriggerOptions) => {
  const names = [options.displayName, options.accountName]
    .filter((name): name is string => name !== undefined && name !== '')
    .sort((a, b) => b.length - a.length)
  return new RegExp(`@(?:${names.map(escapeRegExp).join('|')})`, 'gi')
}
const prefixPattern = (prefix: string) => new RegExp(`^\\s*${escapeRegExp(prefix)}(?=\\s|$)`, 'i')

export function bodyText(message: ZaloMessage): string {
  return [message.text, message.caption].filter((t): t is string => t !== undefined && t !== '').join('\n')
}

/** A group message addresses the bot when it mentions the bot or starts with the prefix word. */
export function hasTrigger(text: string, options: TriggerOptions): boolean {
  return mentionPattern(options).test(text) || prefixPattern(options.groupPrefix).test(text)
}

export function stripTrigger(text: string, options: TriggerOptions): string {
  return text
    .replace(prefixPattern(options.groupPrefix), '')
    .replace(mentionPattern(options), '')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function isoOf(date: number): string {
  const parsed = new Date(date)
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString()
}

/** The chat-log line for a message; `media` lists saved file paths. */
export function logEntryFor(update: ZaloUpdate, media?: string[]): ChatLogEntry {
  const { message } = update
  const text = bodyText(message)
  return {
    ts: isoOf(message.date),
    message_id: message.message_id,
    user_id: message.from.id,
    name: message.from.display_name ?? '',
    text: text === '' ? MARKERS[update.event_name] ?? '' : text,
    ...(media === undefined || media.length === 0 ? {} : { media }),
  }
}

/** Downloads the photo and saves it as `inbox/<message_id><ext>`; undefined when it fails or is not an image. */
async function fetchPhoto(url: string, messageId: string, options: { api: ZaloApi; inboxDir: string; log: { warn(msg: string): void } }): Promise<{ image: InboundImage; path: string } | undefined> {
  try {
    const data = await options.api.downloadUrl(url)
    const mediaType = sniffImageType(data)
    if (mediaType === undefined) throw new Error('not a supported image')
    await mkdir(options.inboxDir, { recursive: true })
    const path = join(options.inboxDir, `${pathSafe(messageId)}${extensionFor(mediaType)}`)
    await writeFile(path, data)
    return { image: { data, mediaType }, path }
  } catch (error) {
    options.log.warn(`dsh-zalo: photo of message ${messageId} could not be downloaded (${error instanceof Error ? error.message : String(error)})`)
    return undefined
  }
}

export async function parseInbound(
  update: ZaloUpdate,
  options: TriggerOptions & { api: ZaloApi; inboxDir: string; log: { warn(msg: string): void } },
): Promise<InboundMessage> {
  const { message } = update
  const isGroup = isGroupChat(message.chat)
  const photo = message.photo === undefined ? undefined : await fetchPhoto(message.photo, message.message_id, options)
  const logEntry = logEntryFor(update, photo === undefined ? undefined : [photo.path])
  let text = isGroup ? stripTrigger(bodyText(message), options) : bodyText(message)
  if (message.photo !== undefined && photo === undefined) text = text === '' ? DOWNLOAD_FAILED : `${text}\n${DOWNLOAD_FAILED}`
  if (text === '') text = MARKERS[update.event_name] ?? ''
  return {
    chatId: message.chat.id,
    messageId: message.message_id,
    isGroup,
    sender: message.from,
    text,
    images: photo === undefined ? [] : [photo.image],
    logEntry,
  }
}
