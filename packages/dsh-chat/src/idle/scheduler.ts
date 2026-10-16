import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { chatKey } from '../keys.ts'
import type { ChatLog, ChatLogEntry } from '../log/chatlog.ts'
import type { ChatChannel, Delivered, InboundImage } from '../router/channel.ts'
import type { ImageStore } from '../router/router.ts'
import { dayKey, emptyChatState, evaluate, observe, type ChatIdleState, type CheckVerdict, type Evaluation } from './burst.ts'
import { decide, idleSystemPrompt, type IdleAction, type IdleLlm, type IdlePhoto } from './engage.ts'
import type { IdleConfig } from './index.ts'

/** One line of the decision log, so missed conversations can be explained afterwards. */
export type IdleEvent = { ts: string } & (
  | { event: 'start'; chatIds: string[]; config: Omit<IdleConfig, 'persona' | 'chatKeys'> }
  | { event: 'check'; chatId: string; verdict: CheckVerdict; fresh?: number; speakers?: number; pickable?: number; burstSince?: string; slotsUsed?: number }
  | { event: 'decision'; chatId: string; action: IdleAction['kind'] | 'cancelled' | 'error'; messageId?: string; as?: Delivered['as']; emoji?: string; text?: string; error?: string }
)
type IdleEventBody = IdleEvent extends infer E ? E extends IdleEvent ? Omit<E, 'ts'> : never : never

/** The slice of the chat router idle acts through. */
export interface IdleChat {
  channel(id: string): ChatChannel | undefined
  enqueue(key: string, task: () => Promise<void>): void
}

export interface IdleDeps {
  config: IdleConfig
  /** The channel this scheduler serves; its chats are `chatIds`. */
  channel: string
  chatIds: string[]
  chat: IdleChat
  provider: string
  model: string
  llm: IdleLlm
  chatLog: ChatLog
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
  observe(chatId: string, entry: ChatLogEntry): void
  noteTurn(chatId: string): void
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
/** Context photos idle can show, by the extension the adapters save them with. */
const PHOTO_TYPES: Record<string, InboundImage['mediaType']> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }

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
  const states = new Map<string, ChatIdleState>(deps.chatIds.map(chatId => [chatId, emptyChatState()]))
  const seeded = new Set<string>()
  /** Lines that arrive while a chat is being seeded; replayed once the seed is in, minus those it already holds. */
  const pending = new Map<string, ChatLogEntry[]>(deps.chatIds.map(chatId => [chatId, []]))
  // Aborted by stop(), so a task queued or running across a plugin reload never acts through the old bot.
  const lifetime = new AbortController()
  const keyOf = (chatId: string) => chatKey(deps.channel, chatId)

  const check = (chatId: string, state: ChatIdleState, verdict: CheckVerdict, result?: Evaluation): void => {
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
  const photos = async (chatId: string, entries: readonly ChatLogEntry[]): Promise<IdlePhoto[]> => {
    if (deps.saveImages === undefined) return []
    const wanted = entries
      .flatMap(e => (e.media ?? []).flatMap((path) => {
        const mediaType = PHOTO_TYPES[extname(path).toLowerCase()]
        return mediaType === undefined ? [] : [{ messageId: e.message_id, path, mediaType }]
      }))
      .slice(-MAX_PHOTOS)
    const read = await Promise.all(wanted.map(async w => readFile(w.path).then(data => [{ messageId: w.messageId, data, mediaType: w.mediaType }], () => [])))
    const found = read.flat()
    if (found.length === 0) return []
    try {
      const refs = await deps.saveImages(found.map(f => ({ data: f.data, mediaType: f.mediaType })))
      return found.map((f, i) => ({ messageId: f.messageId, attachment: refs[i] }))
    } catch (error) {
      log.warn(`dsh-chat: ${deps.channel}:${chatId} idle photos could not be admitted: ${errorText(error)}`)
      return []
    }
  }

  const engage = async (chatId: string, state: ChatIdleState): Promise<void> => {
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
        log.warn(`dsh-chat: ${deps.channel}:${chatId} idle decision with photos failed, retrying without them: ${errorText(error)}`)
        action = await ask([])
      }
    } catch (error) {
      if (!lifetime.signal.aborted) {
        log.warn(`dsh-chat: ${deps.channel}:${chatId} idle decision failed: ${errorText(error)}`)
        record({ event: 'decision', chatId, action: 'error', error: errorText(error) })
      }
      return
    }
    if (lifetime.signal.aborted) return
    log.info(`dsh-chat: ${deps.channel}:${chatId} idle -> ${describeAction(action)}`)
    if (action.kind === 'skip') {
      record({ event: 'decision', chatId, action: 'skip' })
      return
    }
    const detail = action.kind === 'react' ? { emoji: action.emoji } : { text: action.text }
    const at = now()
    try {
      const channel = deps.chat.channel(deps.channel)
      if (channel === undefined) throw new Error(`channel ${deps.channel} offline`)
      // Counted once the channel is there to carry it, as a failed call still counts like before.
      const day = dayKey(at, config.timezone)
      state.count = state.day === day ? state.count + 1 : 1
      state.day = day
      if (action.kind === 'react') state.reacted = [...state.reacted, action.messageId].slice(-MAX_REACTED)
      const delivered = action.kind === 'react'
        ? await channel.react(chatId, action.messageId, action.emoji)
        : await channel.send(chatId, action.text, { replyTo: action.messageId })
      // A reaction that posted a message (a Zalo sticker) is logged like a reply, so the next decision sees it.
      if (delivered.messageId !== undefined) {
        await deps.chatLog.append(keyOf(chatId), {
          ts: new Date(at).toISOString(),
          message_id: delivered.messageId,
          user_id: channel.bot.id,
          name: channel.bot.name,
          text: delivered.text ?? (action.kind === 'reply' ? action.text : action.emoji),
          reply_to: action.messageId,
          bot: true,
        })
      }
      record({ event: 'decision', chatId, action: action.kind, messageId: action.messageId, as: delivered.as, ...detail })
    } catch (error) {
      log.warn(`dsh-chat: ${deps.channel}:${chatId} idle ${action.kind} failed: ${errorText(error)}`)
      record({ event: 'decision', chatId, action: action.kind, messageId: action.messageId, ...detail, error: errorText(error) })
    }
  }

  /**
   * Runs inside the dispatcher task that wrote the line, so the chat's queue is always busy here: the engagement is
   * simply enqueued behind it, and the in-queue re-check cancels it if a turn started meanwhile.
   */
  const consider = (chatId: string, state: ChatIdleState): void => {
    const result = evaluate(state, now(), config, random)
    if (result.verdict !== 'not_hot') check(chatId, state, result.verdict, result)
    if (result.verdict !== 'go') return
    deps.chat.enqueue(keyOf(chatId), () => engage(chatId, state).catch((error: unknown) => {
      log.warn(`dsh-chat: ${deps.channel}:${chatId} idle task failed: ${errorText(error)}`)
    }))
  }

  const live = (chatId: string, state: ChatIdleState, entry: ChatLogEntry): void => {
    try {
      observe(state, entry, config, now())
      if (entry.bot !== true) consider(chatId, state)
    } catch (error) {
      log.warn(`dsh-chat: ${deps.channel}:${chatId} idle check failed: ${errorText(error)}`)
    }
  }

  const lineKey = (entry: ChatLogEntry) => `${entry.bot === true ? 'b' : 'h'}:${entry.message_id}:${entry.ts}`

  const seed = async (chatId: string): Promise<void> => {
    const state = states.get(chatId)!
    const held = new Set<string>()
    try {
      const fresh = emptyChatState()
      for (const entry of await deps.chatLog.readAll(keyOf(chatId))) {
        observe(fresh, entry, config)
        held.add(lineKey(entry))
      }
      state.recent = fresh.recent
      state.burst = fresh.burst
    } catch (error) {
      log.warn(`dsh-chat: ${deps.channel}:${chatId} idle window could not be seeded: ${errorText(error)}`)
    }
    seeded.add(chatId)
    const waiting = pending.get(chatId)!
    pending.delete(chatId)
    for (const entry of waiting) if (!held.has(lineKey(entry))) live(chatId, state, entry)
  }

  log.info(`dsh-chat: ${deps.channel} idle engagement on for ${deps.chatIds.length} chat(s)`)
  const { persona: _persona, chatKeys: _chatKeys, enabled: _enabled, ...settings } = config
  // The start record marks idle as live, so it is written once every window is seeded.
  const ready = Promise.all(deps.chatIds.map(seed)).then(() => {
    record({ event: 'start', chatIds: [...deps.chatIds], config: { enabled: true, ...settings } })
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
