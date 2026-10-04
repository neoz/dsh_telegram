import type { ChatLogEntry } from '../chatlog.ts'
import type { IdleConfig } from './index.ts'

const MINUTE_MS = 60_000
/** A conversation needs at least two people; one person talking to themselves is not hot. */
const MIN_SPEAKERS = 2

export type CheckVerdict = 'go' | 'busy' | 'not_hot' | 'one_speaker' | 'not_idle' | 'burst_spent' | 'nothing_pickable' | 'daily_cap' | 'quiet_hours' | 'chance_miss'

/** Per-chat idle state fed by chat-log lines; times are epoch milliseconds, `day` is the local `dayKey`. */
export interface ChatIdleState {
  /** Recent lines, oldest first: the retention window, never fewer than the newest `contextMessages`. */
  recent: ChatLogEntry[]
  burst: { since: number; lastHumanAt: number; slotsUsed: number }
  lastEngagedAt: number
  lastTurnAt: number
  day: string
  count: number
  /** Newest messages idle reacted to: reactions are not logged, and a second one would replace the first. */
  reacted: number[]
  /** Last check verdict recorded in this burst, so repeats are not logged again. */
  lastVerdict: CheckVerdict | undefined
}

export interface Evaluation { verdict: CheckVerdict; fresh: number; speakers: number; pickable: ReadonlySet<number> }

export function emptyChatState(): ChatIdleState {
  return { recent: [], burst: { since: 0, lastHumanAt: 0, slotsUsed: 0 }, lastEngagedAt: 0, lastTurnAt: 0, day: '', count: 0, reacted: [], lastVerdict: undefined }
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

/** Messages that got a turn or a bot reply; the bot's ACK reaction sits on them. */
export function answeredIds(entries: readonly ChatLogEntry[]): Set<number> {
  return new Set(entries.flatMap((e) => {
    if (e.handled === true) return [e.message_id]
    return e.bot === true && e.reply_to !== undefined ? [e.reply_to] : []
  }))
}

const timeOf = (entry: ChatLogEntry) => Date.parse(entry.ts)

/** Adds a line to the window; a human line after more than `burstGapMinutes` of silence starts a new burst. */
export function observe(state: ChatIdleState, entry: ChatLogEntry, config: IdleConfig): void {
  const at = timeOf(entry)
  state.recent.push(entry)
  const cutoff = at - Math.max(config.hotWindowMinutes, config.burstGapMinutes, config.idleMinutes) * MINUTE_MS
  const firstKept = state.recent.findIndex(e => timeOf(e) >= cutoff)
  const stale = firstKept < 0 ? state.recent.length : firstKept
  const drop = Math.min(stale, Math.max(0, state.recent.length - config.contextMessages))
  if (drop > 0) state.recent.splice(0, drop)
  if (entry.bot === true) return
  if (at - state.burst.lastHumanAt > config.burstGapMinutes * MINUTE_MS) {
    state.burst = { since: at, lastHumanAt: at, slotsUsed: 0 }
    state.lastVerdict = undefined
  } else {
    state.burst.lastHumanAt = at
  }
}

function lastBotActivity(state: ChatIdleState): number {
  const lastBot = state.recent.findLast(e => e.bot === true)
  return Math.max(lastBot === undefined ? 0 : timeOf(lastBot), state.lastEngagedAt, state.lastTurnAt)
}

/**
 * The first condition that blocks, else a chance roll that uses the burst's next slot (so this mutates `state`).
 * With `roll` false (the in-queue re-check) it neither needs a free slot nor rolls.
 */
export function evaluate(state: ChatIdleState, now: number, config: IdleConfig, random: () => number, roll = true): Evaluation {
  const after = now - config.hotWindowMinutes * MINUTE_MS
  const window = state.recent.filter(e => e.bot !== true && timeOf(e) > after)
  const taken = new Set([...answeredIds(state.recent), ...state.reacted])
  const pickable = new Set(window.filter(e => !taken.has(e.message_id)).map(e => e.message_id))
  const fresh = window.length
  const speakers = new Set(window.map(e => e.user_id)).size
  const result = (verdict: CheckVerdict): Evaluation => ({ verdict, fresh, speakers, pickable })
  if (fresh < config.minNewMessages) return result('not_hot')
  if (speakers < MIN_SPEAKERS) return result('one_speaker')
  if (now - lastBotActivity(state) <= config.idleMinutes * MINUTE_MS) return result('not_idle')
  if (roll && state.burst.slotsUsed >= config.maxPerBurst) return result('burst_spent')
  if (pickable.size === 0) return result('nothing_pickable')
  const today = state.day === dayKey(now, config.timezone) ? state.count : 0
  if (today >= config.maxPerDay) return result('daily_cap')
  if (inQuietHours(hourIn(now, config.timezone), config.quietHours)) return result('quiet_hours')
  if (!roll) return result('go')
  state.burst.slotsUsed++
  return result(random() < config.chance ? 'go' : 'chance_miss')
}
