import { describe, expect, it } from 'vitest'
import type { ChatLogEntry } from '../src/chatlog.ts'
import { Config, type IdleConfig } from '../src/config.ts'
import { answeredIds, dayKey, emptyIdleState, hourIn, shouldEngage, type IdleState } from '../src/idle.ts'

const minimal = { botToken: 't', allowFrom: ['ann'], workspaceRoot: '/ws', dataDir: '/data', model: 'm' }
const base: IdleConfig = Config({ ...minimal, idle: { enabled: true, chatIds: [-5] } }).idle
/** 12:00 in Asia/Ho_Chi_Minh (UTC+7). */
const NOON = Date.parse('2026-10-02T05:00:00Z')
const MIN = 60_000

function human(id: number, minutesAgo: number, now = NOON): ChatLogEntry {
  return { ts: new Date(now - minutesAgo * MIN).toISOString(), message_id: id, user_id: 7, username: 'ann', name: 'Ann', text: `m${id}` }
}
function bot(id: number, minutesAgo: number, replyTo?: number, now = NOON): ChatLogEntry {
  return { ts: new Date(now - minutesAgo * MIN).toISOString(), message_id: id, user_id: 1, name: 'dshbot', text: `b${id}`, bot: true, ...(replyTo === undefined ? {} : { reply_to: replyTo }) }
}
/** Bot spoke 90 minutes ago, then five human messages. */
const active = [bot(1, 90), human(2, 80), human(3, 70), human(4, 60), human(5, 50), human(6, 40)]
const hit = () => 0.1
const state = (extra: Partial<IdleState>): IdleState => ({ ...emptyIdleState(), ...extra })
/** The `active` conversation moved so that it ends at `iso` instead of NOON. */
function activeAt(iso: string): { now: number; entries: ChatLogEntry[] } {
  const now = Date.parse(iso)
  return { now, entries: active.map(e => ({ ...e, ts: new Date(Date.parse(e.ts) - NOON + now).toISOString() })) }
}

describe('shouldEngage', () => {
  it('engages when idle, active, under the cap, outside quiet hours and the chance hits', () => {
    expect(shouldEngage(undefined, active, NOON, base, hit)).toBe(true)
  })
  it('waits while the bot spoke recently', () => {
    expect(shouldEngage(undefined, [...active, bot(7, 30)], NOON, base, hit)).toBe(false)
  })
  it('counts a handled turn through lastTurnAt even without a bot log entry', () => {
    expect(shouldEngage(state({ lastTurnAt: NOON - 30 * MIN }), active, NOON, base, hit)).toBe(false)
  })
  it('counts a reaction through lastEngagedAt', () => {
    expect(shouldEngage(state({ lastEngagedAt: NOON - 30 * MIN }), active, NOON, base, hit)).toBe(false)
  })
  it('needs minNewMessages human messages', () => {
    expect(shouldEngage(undefined, active.slice(0, 5), NOON, base, hit)).toBe(false)
  })
  it('after a skip, waits for fresh messages after lastAttemptAt', () => {
    const attempted = state({ lastAttemptAt: NOON - 35 * MIN })
    expect(shouldEngage(attempted, active, NOON, base, hit)).toBe(false)
    const fresh = [...active, human(7, 30), human(8, 25), human(9, 20), human(10, 15), human(11, 10)]
    expect(shouldEngage(attempted, fresh, NOON, base, hit)).toBe(true)
  })
  it('respects the chance roll', () => {
    expect(shouldEngage(undefined, active, NOON, base, () => 0.5)).toBe(false)
    expect(shouldEngage(undefined, active, NOON, { ...base, chance: 0 }, () => 0)).toBe(false)
  })
  it('stops at maxPerDay and resets on a new local day', () => {
    expect(shouldEngage(state({ day: '2026-10-02', count: 5 }), active, NOON, base, hit)).toBe(false)
    expect(shouldEngage(state({ day: '2026-10-01', count: 5 }), active, NOON, base, hit)).toBe(true)
  })
  it('stays silent in quiet hours that wrap midnight', () => {
    const at = (iso: string) => { const { now, entries } = activeAt(iso); return shouldEngage(undefined, entries, now, base, hit) }
    expect(at('2026-10-02T16:30:00Z')).toBe(false) // 23:30 local
    expect(at('2026-10-01T23:59:00Z')).toBe(false) // 06:59 local
    expect(at('2026-10-02T00:00:00Z')).toBe(true) // 07:00 local
  })
  it('treats from === to as no quiet hours', () => {
    const { now, entries } = activeAt('2026-10-02T16:30:00Z')
    expect(shouldEngage(undefined, entries, now, { ...base, quietHours: { from: 0, to: 0 } }, hit)).toBe(true)
  })
})

describe('idle helpers', () => {
  it('computes the local day and hour in the configured timezone', () => {
    expect(dayKey(Date.parse('2026-10-01T17:30:00Z'), 'Asia/Ho_Chi_Minh')).toBe('2026-10-02')
    expect(hourIn(Date.parse('2026-10-01T17:30:00Z'), 'Asia/Ho_Chi_Minh')).toBe(0)
  })
  it('collects the messages the bot answered', () => {
    expect(answeredIds([human(2, 10), bot(3, 5, 2), bot(4, 4)])).toEqual(new Set([2]))
  })
})
