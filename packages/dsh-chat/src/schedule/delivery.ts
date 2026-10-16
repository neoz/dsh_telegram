import { idIn, splitKey } from '../keys.ts'
import type { ChatLog } from '../log/chatlog.ts'
import type { ChatRouter } from '../router/router.ts'
import { afterDelivery, agentPrompt, reminderMessage, type Reminder } from './domain.ts'
import type { ReminderBook } from './store.ts'

/** Node keeps timers in a signed 32-bit millisecond field; longer waits are re-armed in steps. */
const MAX_DELAY_MS = 2_147_483_647
/** After a failed delivery (e.g. the store cannot be written) that reminder waits this long instead of firing again at once. */
const RETRY_AFTER_FAILURE_MS = 60_000

export interface SchedulerDeps {
  book: ReminderBook
  chat: Pick<ChatRouter, 'channel' | 'prompt' | 'superAdmins'>
  chatLog: ChatLog
  log: { info(msg: string): void; warn(msg: string): void }
  now?: () => number
}

export interface SchedulerHandle {
  /** Re-arms the timer after a change to the store. */
  changed(): void
  /** Delivers every due reminder now; the timer calls it. */
  tick(): Promise<void>
  stop(): void
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const keyOf = (reminder: Reminder) => `${reminder.chatKey}/${reminder.record.id}`

export function startScheduler(deps: SchedulerDeps): SchedulerHandle {
  const { book, chat, log } = deps
  const now = deps.now ?? Date.now
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let running: Promise<void> = Promise.resolve()
  /** When a reminder whose delivery failed may be tried again; the others keep their own times. */
  const retryAt = new Map<string, number>()

  /** A reminder is due at its scheduled time, or later while it waits out a failure. */
  const dueAt = (reminder: Reminder) => Math.max(Date.parse(reminder.record.scheduledAt), retryAt.get(keyOf(reminder)) ?? 0)

  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const reminders = book.all()
    const live = new Set(reminders.map(keyOf))
    for (const key of retryAt.keys()) if (!live.has(key)) retryAt.delete(key)
    if (stopped || reminders.length === 0) return
    const at = Math.min(...reminders.map(dueAt))
    timer = setTimeout(() => { void tick() }, Math.min(Math.max(at - now(), 0), MAX_DELAY_MS))
  }

  /** Advances or drops the reminder first, then sends: a crash in between loses one delivery, never duplicates it. */
  const deliver = async (target: Reminder): Promise<void> => {
    const { channel: channelId, id: chatId } = splitKey(target.chatKey)
    // An offline channel leaves the reminder due, so it is retried instead of advanced and lost.
    if (chat.channel(channelId) === undefined) throw new Error(`channel ${channelId} offline`)
    let due: Reminder | undefined
    let revoked = false
    await book.update(channelId, (reminders) => {
      const index = reminders.findIndex(r => r.chatKey === target.chatKey && r.record.id === target.record.id)
      const current = reminders[index]
      if (current === undefined || Date.parse(current.record.scheduledAt) > now()) return
      due = current
      revoked = current.mode === 'agent' && !chat.superAdmins.includes(current.creator.id)
      const next = revoked ? undefined : afterDelivery(current, now())
      if (next === undefined) reminders.splice(index, 1)
      else reminders[index] = next
    })
    const reminder = due
    if (reminder === undefined) return
    const channel = chat.channel(channelId)
    if (channel === undefined) {
      // The channel went away after the reminder was advanced (a shutdown): put it back as it was, so it is not lost.
      await book.update(channelId, (reminders) => {
        const index = reminders.findIndex(r => r.chatKey === reminder.chatKey && r.record.id === reminder.record.id)
        if (index < 0) reminders.push(reminder)
        else reminders[index] = reminder
      })
      throw new Error(`channel ${channelId} offline`)
    }
    if (revoked) {
      await channel.send(chatId, `Stopped reminder "${reminder.record.title}": its creator is no longer a super admin.`)
    } else if (reminder.mode === 'message') {
      const text = reminderMessage(reminder)
      const delivered = await channel.send(chatId, text)
      if (delivered.messageId !== undefined) {
        await deps.chatLog.append(reminder.chatKey, {
          ts: new Date(now()).toISOString(), message_id: delivered.messageId, user_id: channel.bot.id, name: channel.bot.name, text: delivered.text ?? text, bot: true,
        })
      }
    } else {
      chat.prompt(reminder.chatKey, {
        text: agentPrompt(reminder),
        sender: { id: idIn(channelId, reminder.creator.id) ?? reminder.creator.id, name: reminder.creator.name },
        isGroup: reminder.isGroup,
      })
    }
    log.info(`dsh-chat: ${reminder.chatKey} reminder ${reminder.record.id} -> ${revoked ? 'stopped' : reminder.mode}`)
  }

  const tick = (): Promise<void> => {
    running = running.then(async () => {
      const due = book.all().filter(r => dueAt(r) <= now()).sort((a, b) => dueAt(a) - dueAt(b))
      for (const reminder of due) {
        if (stopped) return
        try {
          await deliver(reminder)
          retryAt.delete(keyOf(reminder))
        } catch (error) {
          retryAt.set(keyOf(reminder), now() + RETRY_AFTER_FAILURE_MS)
          if (stopped) return
          log.warn(`dsh-chat: ${reminder.chatKey} reminder ${reminder.record.id} failed: ${errorText(error)}`)
        }
      }
    }).finally(() => arm())
    return running
  }

  arm()
  return {
    changed: () => arm(),
    tick,
    stop: () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}
