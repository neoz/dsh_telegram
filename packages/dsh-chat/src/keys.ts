import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** `<channel>:<id>`, e.g. `telegram:-1001234` or `zalo:abc`; every core store is keyed by it. */
export type ChatKey = string

export function chatKey(channel: string, id: string | number): ChatKey {
  return `${channel}:${id}`
}

export function splitKey(key: ChatKey): { channel: string; id: string } {
  const at = key.indexOf(':')
  if (at <= 0 || at === key.length - 1) throw new Error(`invalid chat key "${key}"`)
  return { channel: key.slice(0, at), id: key.slice(at + 1) }
}

/** The id part of `key` when it belongs to `channel`, else undefined. */
export function idIn(channel: string, key: ChatKey): string | undefined {
  return key.startsWith(`${channel}:`) ? key.slice(channel.length + 1) : undefined
}

/** A file-name-safe form of an id; safe ids stay unchanged, so files written before the move keep their names. */
export function pathSafe(id: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(id)) return id
  return `${id.replace(/[^A-Za-z0-9_-]/g, '_')}-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`
}

/** `<root>/<channel>/<sub>/<pathSafe(id)><ext>`; an empty `sub` puts the file right under the channel. */
export function keyPath(root: string, key: ChatKey, sub: string, ext = ''): string {
  const { channel, id } = splitKey(key)
  return join(root, channel, sub, `${pathSafe(id)}${ext}`)
}
