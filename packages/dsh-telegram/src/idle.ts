import type { ChatLogEntry } from './chatlog.ts'
import type { IdleConfig } from './config.ts'

/** Per-chat idle bookkeeping; times are epoch milliseconds, `day` is the local `dayKey`. */
export interface IdleState { lastEngagedAt: number; lastTurnAt: number; lastAttemptAt: number; day: string; count: number }

const MINUTE_MS = 60_000

export function emptyIdleState(): IdleState {
  return { lastEngagedAt: 0, lastTurnAt: 0, lastAttemptAt: 0, day: '', count: 0 }
}

export function dayKey(now: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function hourIn(now: number, timezone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(now))
}

function inQuietHours(hour: number, quiet: IdleConfig['quietHours']): boolean {
  if (quiet.from === quiet.to) return false
  return quiet.from < quiet.to ? hour >= quiet.from && hour < quiet.to : hour >= quiet.from || hour < quiet.to
}

/** Latest of the newest bot log entry, the last idle engagement, and the last handled turn. */
export function lastBotActivity(state: IdleState, entries: readonly ChatLogEntry[]): number {
  const lastBot = entries.findLast(e => e.bot === true)
  return Math.max(lastBot === undefined ? 0 : Date.parse(lastBot.ts), state.lastEngagedAt, state.lastTurnAt)
}

/** Messages a bot entry replied to; the bot's ACK reaction sits on them. */
export function answeredIds(entries: readonly ChatLogEntry[]): Set<number> {
  return new Set(entries.flatMap(e => (e.bot === true && e.reply_to !== undefined ? [e.reply_to] : [])))
}

export function shouldEngage(state: IdleState | undefined, entries: readonly ChatLogEntry[], now: number, config: IdleConfig, random: () => number): boolean {
  const s = state ?? emptyIdleState()
  const activity = lastBotActivity(s, entries)
  if (now - activity <= config.idleMinutes * MINUTE_MS) return false
  const since = Math.max(activity, s.lastAttemptAt)
  const fresh = entries.filter(e => e.bot !== true && Date.parse(e.ts) > since).length
  if (fresh < config.minNewMessages) return false
  const today = s.day === dayKey(now, config.timezone) ? s.count : 0
  if (today >= config.maxPerDay) return false
  if (inQuietHours(hourIn(now, config.timezone), config.quietHours)) return false
  return random() < config.chance
}
