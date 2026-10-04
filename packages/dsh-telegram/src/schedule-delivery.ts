import { afterDelivery, agentPrompt, dueReminders, nextDueAt, reminderMessage, type Reminder } from './schedule.ts'
import type { ReminderStore } from './schedule-store.ts'
import type { TelegramService } from './service.ts'

/** Node keeps timers in a signed 32-bit millisecond field; longer waits are re-armed in steps. */
const MAX_DELAY_MS = 2_147_483_647

export interface SchedulerDeps {
  store: ReminderStore
  telegram: Pick<TelegramService, 'api' | 'chatLog' | 'bot' | 'superAdmins' | 'prompt'>
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
  const { store, telegram, log } = deps
  const now = deps.now ?? Date.now
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let running: Promise<void> = Promise.resolve()

  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const at = nextDueAt(store.all())
    if (stopped || at === undefined) return
    timer = setTimeout(() => { void tick() }, Math.min(Math.max(at - now(), 0), MAX_DELAY_MS))
  }

  /** Advances or drops the reminder first, then sends: a crash in between loses one delivery, never duplicates it. */
  const deliver = async (id: string): Promise<void> => {
    let due: Reminder | undefined
    let revoked = false
    await store.update((reminders) => {
      const index = reminders.findIndex(r => r.record.id === id)
      const current = reminders[index]
      if (current === undefined || Date.parse(current.record.scheduledAt) > now()) return
      due = current
      revoked = current.mode === 'agent' && !telegram.superAdmins.includes(current.creator.id)
      const next = revoked ? undefined : afterDelivery(current, now())
      if (next === undefined) reminders.splice(index, 1)
      else reminders[index] = next
    })
    const reminder = due
    if (reminder === undefined) return
    const { chatId } = reminder
    if (revoked) {
      await telegram.api.sendMessage(chatId, `Stopped reminder "${reminder.record.title}": its creator is no longer a super admin.`)
    } else if (reminder.mode === 'message') {
      const text = reminderMessage(reminder)
      const sent = await telegram.api.sendMessage(chatId, text)
      await telegram.chatLog.append(chatId, {
        ts: new Date(now()).toISOString(), message_id: sent.messageId, user_id: telegram.bot.id, name: telegram.bot.username, text, bot: true,
      })
    } else {
      telegram.prompt(chatId, { text: agentPrompt(reminder), sender: { id: reminder.creator.id, is_bot: false, first_name: reminder.creator.name } })
    }
    log.info(`dsh-telegram: chat ${chatId} reminder ${reminder.record.id} -> ${revoked ? 'stopped' : reminder.mode}`)
  }

  const tick = (): Promise<void> => {
    running = running.then(async () => {
      for (const reminder of dueReminders(store.all(), now())) {
        if (stopped) return
        try {
          await deliver(reminder.record.id)
        } catch (error) {
          log.warn(`dsh-telegram: chat ${reminder.chatId} reminder ${reminder.record.id} failed: ${errorText(error)}`)
        }
      }
    }).finally(arm)
    return running
  }

  arm()
  return {
    changed: arm,
    tick,
    stop: () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}
