import { randomUUID } from 'node:crypto'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { TelegramUser } from './inbound.ts'
import { buildRecord, canManage, displayName, ReminderError, reminderView, retitle, type Reminder, type ReminderMode, type TimingInput } from './schedule.ts'
import type { ReminderStore } from './schedule-store.ts'
import type { TelegramService } from './service.ts'

export interface ScheduleToolDeps {
  telegram: Pick<TelegramService, 'chatOf' | 'turnOf' | 'superAdmins'>
  store: ReminderStore
  timeZone: string
  maxPerChat: number
  /** Called after every committed change, so the timer can re-arm. */
  changed: () => void
  now?: () => number
  newId?: () => string
}

const ZONE = { type: 'string', description: 'IANA time zone; defaults to the bot zone' } as const
const TIMING = {
  after_seconds: { type: 'integer', description: 'One-shot: seconds from now' },
  at: { type: 'string', description: 'One-shot: ISO 8601 instant with offset, e.g. 2026-10-05T08:00:00+07:00' },
  every_seconds: { type: 'integer', description: 'Repeat every N seconds (at least 60)' },
  daily: {
    type: 'object', description: 'Every day at a local time', additionalProperties: false,
    properties: { time: { type: 'string', required: true, description: 'HH:mm:ss' }, time_zone: ZONE },
  },
  weekly: {
    type: 'object', description: 'Weekly at a local time', additionalProperties: false,
    properties: {
      time: { type: 'string', required: true, description: 'HH:mm:ss' },
      weekdays: { type: 'array', items: { type: 'integer' }, required: true, description: 'ISO weekdays, Monday 1 to Sunday 7' },
      time_zone: ZONE,
    },
  },
  cron: {
    type: 'object', description: 'Five-field cron: minute hour day-of-month month day-of-week', additionalProperties: false,
    properties: { expression: { type: 'string', required: true, description: 'e.g. 0 9 * * 1-5' }, time_zone: ZONE },
  },
} as const
const JSON_OUTPUT = { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] } as const

function timingOf(args: TimingInput): TimingInput {
  const timing: TimingInput = {}
  for (const key of ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'] as const) {
    if (args[key] !== undefined) Object.assign(timing, { [key]: args[key] })
  }
  return timing
}

/** Resolves the calling chat and sender, runs `body`, and renders the result or a `{ code, message }` failure as JSON. */
async function inChat(deps: ScheduleToolDeps, exec: ToolRunContext, body: (chatId: number, sender: TelegramUser) => Promise<unknown>): Promise<string> {
  try {
    const chatId = exec.agent === undefined ? undefined : deps.telegram.chatOf(String(exec.agent.id))
    const turn = chatId === undefined ? undefined : deps.telegram.turnOf(chatId)
    if (chatId === undefined || turn === undefined) throw new ReminderError('no_chat', 'reminders can only be managed from a chat turn')
    return JSON.stringify(await body(chatId, turn.sender))
  } catch (error) {
    if (error instanceof ReminderError) return JSON.stringify({ code: error.code, message: error.message })
    throw error
  }
}

/** Store changes report a failed write as storage_failed; a ReminderError from the change itself passes through. */
async function commit<T>(deps: ScheduleToolDeps, change: (reminders: Reminder[]) => T): Promise<T> {
  let result: T
  try {
    result = await deps.store.update(change)
  } catch (error) {
    if (error instanceof ReminderError) throw error
    throw new ReminderError('storage_failed', `the reminder could not be saved: ${error instanceof Error ? error.message : String(error)}`)
  }
  deps.changed()
  return result
}

/** The chat's reminder with this id, or schedule_not_found (another chat's reminder counts as missing). */
function find(reminders: Reminder[], chatId: number, id: string): number {
  const index = reminders.findIndex(r => r.chatId === chatId && r.record.id === id)
  if (index < 0) throw new ReminderError('schedule_not_found', `no reminder ${id} in this chat`)
  return index
}

function assertCanManage(deps: ScheduleToolDeps, reminder: Reminder, sender: TelegramUser): void {
  if (!canManage(reminder, sender.id, deps.telegram.superAdmins)) {
    throw new ReminderError('forbidden', 'only the creator or a super admin can change this reminder')
  }
}

export function createScheduleTools(deps: ScheduleToolDeps): ToolDefinition[] {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => randomUUID().slice(0, 8))

  const create = defineTool({
    name: 'schedule_create',
    description: 'Create a reminder in this chat. mode "message" sends the prompt as a message when due; mode "agent" (super admins only) runs the prompt as an instruction. Give exactly one timing field.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short name, at most 120 characters' },
      prompt: { type: 'string', required: true, description: 'Message text, or the instruction for mode "agent"' },
      mode: { type: 'string', enum: ['message', 'agent'], description: 'Defaults to "message"' },
      ...TIMING,
    },
    output: JSON_OUTPUT,
    execute: (args, exec) => inChat(deps, exec, async (chatId, sender) => {
      const mode: ReminderMode = args.mode === 'agent' ? 'agent' : 'message'
      if (mode === 'agent' && !deps.telegram.superAdmins.includes(sender.id)) {
        throw new ReminderError('forbidden', 'only super admins can create agent reminders')
      }
      const record = buildRecord(newId(), args.title, args.prompt, timingOf(args as TimingInput), now(), deps.timeZone)
      const reminder: Reminder = { chatId, creator: { id: sender.id, name: displayName(sender) }, mode, record }
      await commit(deps, (reminders) => {
        if (reminders.filter(r => r.chatId === chatId).length >= deps.maxPerChat) {
          throw new ReminderError('limit_reached', `this chat already has ${deps.maxPerChat} reminders; delete one first`)
        }
        reminders.push(reminder)
      })
      return reminderView(reminder)
    }),
  })

  const list = defineTool({
    name: 'schedule_list',
    description: 'List the reminders of this chat.',
    parameters: {},
    output: JSON_OUTPUT,
    execute: (_args, exec) => inChat(deps, exec, async chatId => deps.store.all().filter(r => r.chatId === chatId).map(reminderView)),
  })

  const { after_seconds: _after, ...UPDATE_TIMING } = TIMING
  const update = defineTool({
    name: 'schedule_update',
    description: 'Change the title, prompt or timing of a reminder in this chat (creator or super admins). A timing change re-anchors from now; after_seconds is not accepted.',
    parameters: {
      id: { type: 'string', required: true, description: 'Reminder id' },
      title: { type: 'string', description: 'New title' },
      prompt: { type: 'string', description: 'New message or instruction' },
      ...UPDATE_TIMING,
    },
    output: JSON_OUTPUT,
    execute: (args, exec) => inChat(deps, exec, async (chatId, sender) => {
      // Not in the schema, but the parameter root is open: reject it rather than silently keep the old timing.
      if ((args as Record<string, unknown>).after_seconds !== undefined) {
        throw new ReminderError('invalid_rule', 'after_seconds cannot be used to update a reminder; use at')
      }
      const timing = timingOf(args as TimingInput)
      const changes = { ...(args.title === undefined ? {} : { title: args.title }), ...(args.prompt === undefined ? {} : { prompt: args.prompt }) }
      return commit(deps, (reminders) => {
        const index = find(reminders, chatId, args.id)
        const current = reminders[index]!
        assertCanManage(deps, current, sender)
        const titled = retitle(current.record, changes)
        const record = Object.keys(timing).length === 0
          ? titled
          : buildRecord(current.record.id, titled.title, titled.prompt, timing, now(), deps.timeZone)
        reminders[index] = { ...current, record }
        return reminderView(reminders[index]!)
      })
    }),
  })

  const remove = defineTool({
    name: 'schedule_delete',
    description: 'Delete a reminder in this chat (creator or super admins).',
    parameters: { id: { type: 'string', required: true, description: 'Reminder id' } },
    output: JSON_OUTPUT,
    execute: (args, exec) => inChat(deps, exec, async (chatId, sender) => commit(deps, (reminders) => {
      const index = find(reminders, chatId, args.id)
      assertCanManage(deps, reminders[index]!, sender)
      reminders.splice(index, 1)
      return { id: args.id, deleted: true }
    })),
  })

  return [create, list, update, remove]
}
