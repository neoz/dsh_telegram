import { describe, expect, it } from 'vitest'
import type { ChatLogEntry } from '../../src/chatlog.ts'
import { answeredIds, dayKey, emptyChatState, evaluate, hourIn, observe, type ChatIdleState } from '../../src/idle/burst.ts'
import { Config, type IdleConfig } from '../../src/idle/index.ts'

/** 12:00 in Asia/Ho_Chi_Minh. */
const NOW = Date.parse('2026-10-04T05:00:00Z')
/** 00:30 in Asia/Ho_Chi_Minh, inside the default quiet hours. */
const NIGHT = Date.parse('2026-10-03T17:30:00Z')
const MIN = 60_000
const base: IdleConfig = Config({ enabled: true, chatIds: [-5], idleMinutes: 10, minNewMessages: 5, chance: 0.5 })

function human(id: number, minutesAgo: number, user = 7, now = NOW): ChatLogEntry {
  return { ts: new Date(now - minutesAgo * MIN).toISOString(), message_id: id, user_id: user, username: `u${user}`, name: `U${user}`, text: `m${id}` }
}
function bot(id: number, minutesAgo: number, replyTo?: number, now = NOW): ChatLogEntry {
  return { ts: new Date(now - minutesAgo * MIN).toISOString(), message_id: id, user_id: 1, name: 'dshbot', text: `b${id}`, bot: true, ...(replyTo === undefined ? {} : { reply_to: replyTo }) }
}
/** Five messages in the last four minutes from two speakers. */
const hot = (now = NOW) => [human(1, 4, 7, now), human(2, 3, 8, now), human(3, 2, 7, now), human(4, 1, 8, now), human(5, 0.5, 7, now)]
function stateWith(entries: ChatLogEntry[], config = base): ChatIdleState {
  const state = emptyChatState()
  for (const entry of entries) observe(state, entry, config)
  return state
}
const hit = () => 0.1

describe('evaluate', () => {
  it('goes when a burst is hot, using one slot', () => {
    const state = stateWith(hot())
    const result = evaluate(state, NOW, base, hit)
    expect(result).toMatchObject({ verdict: 'go', fresh: 5, speakers: 2 })
    expect([...result.pickable]).toEqual([1, 2, 3, 4, 5])
    expect(state.burst.slotsUsed).toBe(1)
  })

  it('names the first condition that blocks', () => {
    expect(evaluate(stateWith(hot().slice(0, 4)), NOW, base, hit).verdict).toBe('not_hot')
    expect(evaluate(stateWith(hot().map(e => ({ ...e, user_id: 7 }))), NOW, base, hit).verdict).toBe('one_speaker')
    expect(evaluate(stateWith([...hot(), bot(9, 3)]), NOW, base, hit).verdict).toBe('not_idle')
    const turned = stateWith(hot())
    turned.lastTurnAt = NOW - MIN
    expect(evaluate(turned, NOW, base, hit).verdict).toBe('not_idle')
    expect(evaluate(stateWith(hot().map(e => ({ ...e, handled: true as const }))), NOW, base, hit).verdict).toBe('nothing_pickable')
    const capped = stateWith(hot())
    capped.day = dayKey(NOW, base.timezone)
    capped.count = base.maxPerDay
    expect(evaluate(capped, NOW, base, hit).verdict).toBe('daily_cap')
    expect(evaluate(stateWith(hot(NIGHT)), NIGHT, base, hit).verdict).toBe('quiet_hours')
  })

  it('rolls chance once per slot: a miss spends the slot', () => {
    const state = stateWith(hot())
    expect(evaluate(state, NOW, base, () => 0.9).verdict).toBe('chance_miss')
    expect(evaluate(state, NOW, base, hit).verdict).toBe('burst_spent')
  })

  it('the in-queue re-check neither rolls nor needs a free slot', () => {
    const state = stateWith(hot())
    evaluate(state, NOW, base, hit)
    expect(evaluate(state, NOW, base, () => 0.99, false).verdict).toBe('go')
    expect(state.burst.slotsUsed).toBe(1)
  })

  it('allows a second slot with maxPerBurst 2 once the bot has been idle for idleMinutes', () => {
    const config = { ...base, maxPerBurst: 2 }
    const state = stateWith(hot(), config)
    expect(evaluate(state, NOW, config, hit).verdict).toBe('go')
    const later = NOW + 11 * MIN
    // The burst continues: the gap from the last message stays under burstGapMinutes.
    for (const [i, m] of [4, 3, 2, 1, 0.5].entries()) observe(state, human(20 + i, m, i % 2 === 0 ? 7 : 8, later), config)
    expect(state.burst.slotsUsed).toBe(1)
    state.lastEngagedAt = NOW + 2 * MIN
    expect(evaluate(state, later, config, hit).verdict).toBe('not_idle')
    state.lastEngagedAt = NOW
    expect(evaluate(state, later, config, hit).verdict).toBe('go')
    expect(evaluate(state, later, config, hit).verdict).toBe('burst_spent')
  })
})

describe('observe', () => {
  it('starts a new burst after burstGapMinutes of silence, resetting slots and the last verdict', () => {
    const state = stateWith(hot())
    evaluate(state, NOW, base, hit)
    state.lastVerdict = 'burst_spent'
    const next = human(30, -16, 8)
    observe(state, next, base)
    expect(state.burst).toEqual({ since: Date.parse(next.ts), lastHumanAt: Date.parse(next.ts), slotsUsed: 0 })
    expect(state.lastVerdict).toBeUndefined()
  })

  it('bot lines join the window but never start or extend a burst', () => {
    const state = stateWith(hot())
    const { burst } = state
    observe(state, bot(40, -1), base)
    expect(state.burst).toEqual(burst)
    expect(state.recent.at(-1)!.message_id).toBe(40)
  })

  it('keeps the retention window but never fewer than contextMessages entries', () => {
    const spread = Array.from({ length: 30 }, (_, i) => human(100 + i, (30 - i) * 60))
    expect(stateWith(spread).recent).toHaveLength(base.contextMessages)
    const dense = Array.from({ length: 25 }, (_, i) => human(200 + i, 1 - i / 100))
    expect(stateWith(dense).recent).toHaveLength(25)
  })
})

describe('helpers', () => {
  it('computes the local day and hour in the configured timezone', () => {
    expect(dayKey(Date.parse('2026-10-01T17:30:00Z'), 'Asia/Ho_Chi_Minh')).toBe('2026-10-02')
    expect(hourIn(Date.parse('2026-10-01T17:30:00Z'), 'Asia/Ho_Chi_Minh')).toBe(0)
  })
  it('collects the messages the bot answered or handled', () => {
    expect(answeredIds([human(2, 10), bot(3, 5, 2), bot(4, 4), { ...human(5, 3), handled: true }])).toEqual(new Set([2, 5]))
  })
  it('never offers a message answered or already reacted to', () => {
    const state = stateWith([human(2, 4, 7), bot(3, 3.5, 2), human(4, 3, 8), human(5, 2, 7), human(6, 1, 8), human(7, 0.5, 7)])
    state.lastEngagedAt = 0
    state.reacted = [5]
    expect([...evaluate(state, NOW, { ...base, idleMinutes: 1 }, hit, false).pickable]).toEqual([4, 6, 7])
  })
})
