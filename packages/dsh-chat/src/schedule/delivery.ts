import { idIn, splitKey } from '../keys.ts'
import type { ChatLog } from '../log/chatlog.ts'
import type { ChatRouter } from '../router/router.ts'
import { afterDelivery, agentPrompt, dueReminders, nextDueAt, reminderMessage, type Reminder } from './domain.ts'
import type { ReminderBook } from './store.ts'

/** Node keeps timers in a signed 32-bit millisecond field; longer waits are re-armed in steps. */
const MAX_DELAY_MS = 2_147_483_647
/** After a failed delivery (e.g. the store cannot be written) the timer waits this long instead of firing again at once. */
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

export function startScheduler(deps: SchedulerDeps): SchedulerHandle {
  const { book, chat, log } = deps
  const now = deps.now ?? Date.now
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let running: Promise<void> = Promise.resolve()

  const arm = (minDelayMs = 0): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const at = nextDueAt(book.all())
    if (stopped || at === undefined) return
    timer = setTimeout(() => { void tick() }, Math.min(Math.max(at - now(), minDelayMs), MAX_DELAY_MS))
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
    if (channel === undefined) throw new Error(`channel ${channelId} offline`)
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
    let failed = false
    running = running.then(async () => {
      for (const reminder of dueReminders(book.all(), now())) {
        if (stopped) return
        try {
          await deliver(reminder)
        } catch (error) {
          failed = true
          if (stopped) return
          log.warn(`dsh-chat: ${reminder.chatKey} reminder ${reminder.record.id} failed: ${errorText(error)}`)
        }
      }
    }).finally(() => arm(failed ? RETRY_AFTER_FAILURE_MS : 0))
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
