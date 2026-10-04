import type { ChatLog, ChatLogEntry } from '../chatlog.ts'
import type { TelegramApi } from '../telegram-api.ts'
import { dayKey, emptyChatState, evaluate, observe, type ChatIdleState, type CheckVerdict, type Evaluation } from './burst.ts'
import { decide, idleSystemPrompt, type IdleAction, type IdleLlm } from './engage.ts'
import type { IdleConfig } from './index.ts'

/** One line of the decision log, so missed conversations can be explained afterwards. */
export type IdleEvent = { ts: string } & (
  | { event: 'start'; chatIds: number[]; config: Omit<IdleConfig, 'persona' | 'chatIds'> }
  | { event: 'check'; chatId: number; verdict: CheckVerdict; fresh?: number; speakers?: number; pickable?: number; burstSince?: string; slotsUsed?: number }
  | { event: 'decision'; chatId: number; action: IdleAction['kind'] | 'cancelled' | 'error'; messageId?: number; emoji?: string; text?: string; error?: string }
)
type IdleEventBody = IdleEvent extends infer E ? E extends IdleEvent ? Omit<E, 'ts'> : never : never

export interface IdleQueue { enqueue(chatId: number, task: () => Promise<void>): void; isBusy(chatId: number): boolean }

export interface IdleDeps {
  config: IdleConfig
  provider: string
  model: string
  llm: IdleLlm
  api: TelegramApi
  chatLog: ChatLog
  queue: IdleQueue
  botId: number
  botUsername: string
  log: { info(msg: string): void; warn(msg: string): void }
  now?: () => number
  random?: () => number
  /** Receives every start, check and decision; the plugin appends them to a JSONL file. */
  record?: (event: IdleEvent) => void
}

export interface IdleHandle {
  /** Feeds one chat-log line; a human line in an allowlisted chat is evaluated. */
  observe(chatId: number, entry: ChatLogEntry): void
  noteTurn(chatId: number): void
  /** Resolves once every allowlisted chat's window is seeded from its log. */
  ready: Promise<void>
  stop(): void
}

const IDLE_TIMEOUT_MS = 60_000
const MAX_REACTED = 50
/** Each roll is its own event, so these are logged even when they repeat. */
const ROLLED: ReadonlySet<CheckVerdict> = new Set(['go', 'chance_miss'])

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

function describeAction(action: IdleAction): string {
  if (action.kind === 'skip') return 'skip'
  return action.kind === 'react' ? `react ${action.emoji} on ${action.messageId}` : `reply on ${action.messageId}`
}

/** Lets the bot join a group as soon as a conversation there gets hot, at most `maxPerBurst` times per burst. */
export function startIdle(deps: IdleDeps): IdleHandle {
  const { config, log } = deps
  if (!config.enabled) return { observe: () => {}, noteTurn: () => {}, ready: Promise.resolve(), stop: () => {} }
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const system = idleSystemPrompt(config.persona, deps.model)
  const record = (event: IdleEventBody): void => deps.record?.({ ts: new Date(now()).toISOString(), ...event } as IdleEvent)
  const states = new Map<number, ChatIdleState>(config.chatIds.map(chatId => [chatId, emptyChatState()]))
  const seeded = new Set<number>()
  // Aborted by stop(), so a task queued or running across a plugin reload never acts through the old bot.
  const lifetime = new AbortController()

  const check = (chatId: number, state: ChatIdleState, verdict: CheckVerdict, result?: Evaluation): void => {
    if (state.lastVerdict === verdict && !ROLLED.has(verdict)) return
    state.lastVerdict = verdict
    record({
      event: 'check', chatId, verdict,
      ...(result === undefined ? {} : {
        fresh: result.fresh, speakers: result.speakers, pickable: result.pickable.size,
        burstSince: new Date(state.burst.since).toISOString(), slotsUsed: state.burst.slotsUsed,
      }),
    })
  }

  const engage = async (chatId: number, state: ChatIdleState): Promise<void> => {
    if (lifetime.signal.aborted) return
    // Re-check without rolling or needing a slot: the bot may have been addressed while this task waited.
    const recheck = evaluate(state, now(), config, random, false)
    if (recheck.verdict !== 'go') {
      record({ event: 'decision', chatId, action: 'cancelled' })
      return
    }
    let action: IdleAction
    try {
      action = await decide(deps.llm, state.recent.slice(-config.contextMessages), {
        provider: deps.provider,
        model: deps.model,
        system,
        pickable: recheck.pickable,
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(IDLE_TIMEOUT_MS)]),
      })
    } catch (error) {
      if (!lifetime.signal.aborted) {
        log.warn(`dsh-telegram: chat ${chatId} idle decision failed: ${errorText(error)}`)
        record({ event: 'decision', chatId, action: 'error', error: errorText(error) })
      }
      return
    }
    if (lifetime.signal.aborted) return
    log.info(`dsh-telegram: chat ${chatId} idle -> ${describeAction(action)}`)
    if (action.kind === 'skip') {
      record({ event: 'decision', chatId, action: 'skip' })
      return
    }
    const detail = action.kind === 'react' ? { emoji: action.emoji } : { text: action.text }
    const at = now()
    const day = dayKey(at, config.timezone)
    state.count = state.day === day ? state.count + 1 : 1
    state.day = day
    state.lastEngagedAt = at
    try {
      if (action.kind === 'react') {
        state.reacted = [...state.reacted, action.messageId].slice(-MAX_REACTED)
        await deps.api.setReaction(chatId, action.messageId, action.emoji)
        record({ event: 'decision', chatId, action: 'react', messageId: action.messageId, ...detail })
        return
      }
      const sent = await deps.api.sendMessage(chatId, action.text, { replyTo: { messageId: action.messageId } })
      await deps.chatLog.append(chatId, {
        ts: new Date(at).toISOString(),
        message_id: sent.messageId,
        user_id: deps.botId,
        name: deps.botUsername,
        text: action.text,
        reply_to: action.messageId,
        bot: true,
      })
      record({ event: 'decision', chatId, action: 'reply', messageId: action.messageId, ...detail })
    } catch (error) {
      log.warn(`dsh-telegram: chat ${chatId} idle ${action.kind} failed: ${errorText(error)}`)
      record({ event: 'decision', chatId, action: action.kind, messageId: action.messageId, ...detail, error: errorText(error) })
    }
  }

  const consider = (chatId: number, state: ChatIdleState): void => {
    if (deps.queue.isBusy(chatId)) {
      check(chatId, state, 'busy')
      return
    }
    const result = evaluate(state, now(), config, random)
    if (result.verdict !== 'not_hot') check(chatId, state, result.verdict, result)
    if (result.verdict !== 'go') return
    deps.queue.enqueue(chatId, () => engage(chatId, state).catch((error: unknown) => {
      log.warn(`dsh-telegram: chat ${chatId} idle task failed: ${errorText(error)}`)
    }))
  }

  const seed = async (chatId: number): Promise<void> => {
    try {
      const fresh = emptyChatState()
      for (const entry of await deps.chatLog.readAll(chatId)) observe(fresh, entry, config)
      const state = states.get(chatId)!
      state.recent = fresh.recent
      state.burst = fresh.burst
    } catch (error) {
      log.warn(`dsh-telegram: chat ${chatId} idle window could not be seeded: ${errorText(error)}`)
    }
    seeded.add(chatId)
  }

  const ready = Promise.all(config.chatIds.map(seed)).then(() => {})
  log.info(`dsh-telegram: idle engagement on for ${config.chatIds.length} chat(s)`)
  const { persona: _persona, chatIds, enabled: _enabled, ...settings } = config
  record({ event: 'start', chatIds: [...chatIds], config: { enabled: true, ...settings } })
  return {
    observe: (chatId, entry) => {
      const state = states.get(chatId)
      // Lines that arrive while seeding are already in the log the seed reads.
      if (state === undefined || !seeded.has(chatId) || lifetime.signal.aborted) return
      try {
        observe(state, entry, config)
        if (entry.bot !== true) consider(chatId, state)
      } catch (error) {
        log.warn(`dsh-telegram: chat ${chatId} idle check failed: ${errorText(error)}`)
      }
    },
    noteTurn: (chatId) => {
      const state = states.get(chatId)
      if (state !== undefined) state.lastTurnAt = now()
    },
    ready,
    stop: () => { lifetime.abort() },
  }
}
