import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { ImageStore } from '../bot.ts'
import { chatKey, type ChatLog, type ChatLogEntry } from 'dsh-chat'
import type { TelegramApi } from '../telegram-api.ts'
import { dayKey, emptyChatState, evaluate, observe, type ChatIdleState, type CheckVerdict, type Evaluation } from './burst.ts'
import { decide, idleSystemPrompt, type IdleAction, type IdleLlm, type IdlePhoto } from './engage.ts'
import type { IdleConfig } from './index.ts'

/** One line of the decision log, so missed conversations can be explained afterwards. */
export type IdleEvent = { ts: string } & (
  | { event: 'start'; chatIds: number[]; config: Omit<IdleConfig, 'persona' | 'chatIds'> }
  | { event: 'check'; chatId: number; verdict: CheckVerdict; fresh?: number; speakers?: number; pickable?: number; burstSince?: string; slotsUsed?: number }
  | { event: 'decision'; chatId: number; action: IdleAction['kind'] | 'cancelled' | 'error'; messageId?: string; emoji?: string; text?: string; error?: string }
)
type IdleEventBody = IdleEvent extends infer E ? E extends IdleEvent ? Omit<E, 'ts'> : never : never

export interface IdleQueue { enqueue(chatId: number, task: () => Promise<void>): void }

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
  /** Admits context photos as attachments; without it the model sees only the `[photo]` text. */
  saveImages?: ImageStore['saveImages']
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
/** Newest context photos shown to the model; older ones stay `[photo]` text. */
const MAX_PHOTOS = 3
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
  /** Lines that arrive while a chat is being seeded; replayed once the seed is in, minus those it already holds. */
  const pending = new Map<number, ChatLogEntry[]>(config.chatIds.map(chatId => [chatId, []]))
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

  /** Reads the newest saved photos of the context; a file swept by retention is left out. */
  const photos = async (chatId: number, entries: readonly ChatLogEntry[]): Promise<IdlePhoto[]> => {
    if (deps.saveImages === undefined) return []
    const wanted = entries
      .flatMap(e => (e.media ?? []).filter(path => extname(path).toLowerCase() === '.jpg').map(path => ({ messageId: e.message_id, path })))
      .slice(-MAX_PHOTOS)
    const read = await Promise.all(wanted.map(async w => readFile(w.path).then(data => [{ messageId: w.messageId, data }], () => [])))
    const found = read.flat()
    if (found.length === 0) return []
    try {
      const refs = await deps.saveImages(found.map(f => ({ data: f.data, mediaType: 'image/jpeg' as const })))
      return found.map((f, i) => ({ messageId: f.messageId, attachment: refs[i] }))
    } catch (error) {
      log.warn(`dsh-telegram: chat ${chatId} idle photos could not be admitted: ${errorText(error)}`)
      return []
    }
  }

  const engage = async (chatId: number, state: ChatIdleState): Promise<void> => {
    if (lifetime.signal.aborted) return
    // Re-check without rolling or needing a slot: the bot may have been addressed while this task waited.
    const recheck = evaluate(state, now(), config, random, false)
    if (recheck.verdict !== 'go') {
      record({ event: 'decision', chatId, action: 'cancelled' })
      return
    }
    const context = state.recent.slice(-config.contextMessages).map(e => e.entry)
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(IDLE_TIMEOUT_MS)])
    const ask = (shown: readonly IdlePhoto[]) => decide(deps.llm, context, { provider: deps.provider, model: deps.model, system, pickable: recheck.pickable, photos: shown, signal })
    let action: IdleAction
    try {
      const shown = await photos(chatId, context)
      try {
        action = await ask(shown)
      } catch (error) {
        // A model or route that refuses images still gets to decide from the text.
        if (shown.length === 0 || lifetime.signal.aborted) throw error
        log.warn(`dsh-telegram: chat ${chatId} idle decision with photos failed, retrying without them: ${errorText(error)}`)
        action = await ask([])
      }
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
    try {
      if (action.kind === 'react') {
        state.reacted = [...state.reacted, action.messageId].slice(-MAX_REACTED)
        await deps.api.setReaction(chatId, Number(action.messageId), action.emoji)
        record({ event: 'decision', chatId, action: 'react', messageId: action.messageId, ...detail })
        return
      }
      const sent = await deps.api.sendMessage(chatId, action.text, { replyTo: { messageId: Number(action.messageId) } })
      await deps.chatLog.append(chatKey('telegram', chatId), {
        ts: new Date(at).toISOString(),
        message_id: String(sent.messageId),
        user_id: String(deps.botId),
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

  /**
   * Runs inside the dispatcher task that wrote the line, so the chat's queue is always busy here: the engagement is
   * simply enqueued behind it, and the in-queue re-check cancels it if a turn started meanwhile.
   */
  const consider = (chatId: number, state: ChatIdleState): void => {
    const result = evaluate(state, now(), config, random)
    if (result.verdict !== 'not_hot') check(chatId, state, result.verdict, result)
    if (result.verdict !== 'go') return
    deps.queue.enqueue(chatId, () => engage(chatId, state).catch((error: unknown) => {
      log.warn(`dsh-telegram: chat ${chatId} idle task failed: ${errorText(error)}`)
    }))
  }

  const live = (chatId: number, state: ChatIdleState, entry: ChatLogEntry): void => {
    try {
      observe(state, entry, config, now())
      if (entry.bot !== true) consider(chatId, state)
    } catch (error) {
      log.warn(`dsh-telegram: chat ${chatId} idle check failed: ${errorText(error)}`)
    }
  }

  const lineKey = (entry: ChatLogEntry) => `${entry.bot === true ? 'b' : 'h'}:${entry.message_id}:${entry.ts}`

  const seed = async (chatId: number): Promise<void> => {
    const state = states.get(chatId)!
    const held = new Set<string>()
    try {
      const fresh = emptyChatState()
      for (const entry of await deps.chatLog.readAll(chatKey('telegram', chatId))) {
        observe(fresh, entry, config)
        held.add(lineKey(entry))
      }
      state.recent = fresh.recent
      state.burst = fresh.burst
    } catch (error) {
      log.warn(`dsh-telegram: chat ${chatId} idle window could not be seeded: ${errorText(error)}`)
    }
    seeded.add(chatId)
    const waiting = pending.get(chatId)!
    pending.delete(chatId)
    for (const entry of waiting) if (!held.has(lineKey(entry))) live(chatId, state, entry)
  }

  log.info(`dsh-telegram: idle engagement on for ${config.chatIds.length} chat(s)`)
  const { persona: _persona, chatIds, enabled: _enabled, ...settings } = config
  // The start record marks idle as live, so it is written once every window is seeded.
  const ready = Promise.all(config.chatIds.map(seed)).then(() => {
    record({ event: 'start', chatIds: [...chatIds], config: { enabled: true, ...settings } })
  })
  return {
    observe: (chatId, entry) => {
      const state = states.get(chatId)
      if (state === undefined || lifetime.signal.aborted) return
      if (!seeded.has(chatId)) {
        pending.get(chatId)?.push(entry)
        return
      }
      live(chatId, state, entry)
    },
    noteTurn: (chatId) => {
      const state = states.get(chatId)
      if (state !== undefined) state.lastTurnAt = now()
    },
    ready,
    stop: () => { lifetime.abort() },
  }
}
