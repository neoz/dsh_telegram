# dsh-telegram: reminders as their own plugin

Date: 2026-10-04
Status: approved design, pending implementation plan

## Goal

Let people ask the bot for reminders ("remind me at 8 tomorrow", "every
Monday at 9 summarise the week") and have them delivered in the chat where
they were created. Reminders survive restarts. The feature is a separate
Cordis plugin, `dsh-telegram/schedule`, built on the `telegram` service (see
`2026-10-04-telegram-idle-plugin-design.md`).

`@deepseek-ai/dsh-schedule` cannot be mounted in this profile: it delivers
through the Host Web Session controller, which a headless composition lacks.
Its pure domain helpers are reused instead.

## Decisions

| Topic | Decision |
|---|---|
| Delivery | Per reminder, chosen at creation: `message` sends the stored text; `agent` runs an agent turn with the stored instruction. |
| Timing | The six `dsh-schedule` selectors: `after_seconds`, `at`, `every_seconds`, `daily`, `weekly`, `cron`. |
| Scheduling logic | Reused from `@deepseek-ai/dsh-schedule` (peer dependency, present in the dsh install): `create{After,At,Every,Daily,Weekly,Cron}ScheduleRecord`, `resolveRecurringOccurrence`, `isRecurringScheduleRecord`. No cron library is added. |
| Scope | A reminder belongs to the chat where it was created. |
| Permissions | Anyone in the chat lists its reminders. Only the creator or a super admin updates or deletes one. Only super admins create `agent` reminders. |
| Limit | `maxPerChat` active reminders per chat (default 20). |
| Persistence | One JSON file, `dataDir/schedule.json`, written atomically. |
| Missed occurrences | At start, an overdue one-shot is delivered at once; a recurring reminder delivers only its latest missed occurrence, then advances (the `dsh-schedule` rule). |
| Ordering | Advance or delete the stored reminder first, then send: a crash in between can lose one delivery, never duplicate it. |

## Core: `telegram` service additions

`TelegramService` (`src/service.ts`) gains:

```ts
superAdmins: readonly number[]
/** Chat owning a live agent; undefined for subagents and unknown sessions. */
chatOf(agentId: string): number | undefined
/** Sender of the running turn in that chat. */
turnOf(chatId: number): { sender: TelegramUser; isGroup: boolean } | undefined
/** Queue an agent turn in the chat as if `sender` had written `text`; the reply quotes no message. */
prompt(chatId: number, input: { text: string; sender: TelegramUser }): void
```

- `chatOf` and `turnOf` come from `ChatAgents` (`turnOf` already exists;
  `chatOf` maps a live agent id back to its chat).
- The tail of `handleMessage` (resolve agent, `setTurn`, memory block,
  `runTurn`, bot chat-log entry, timing log) becomes
  `runChatTurn(deps, chatId, input)`, shared by messages and `prompt()`.
  `prompt()` enqueues it on the chat's dispatcher queue, so it never overlaps
  another turn of that chat. Compared with a message it sets no ACK reaction,
  quotes nothing (`runTurn`'s `replyToMessageId` becomes optional), adds no
  `<group_messages>` block, and logs the bot entry without `reply_to`. It
  still emits `telegram/turn`, so idle counts it as bot activity.
- During a `prompt()` turn, `turnOf` returns the given sender, so chat tools
  keep checking permissions against the reminder's creator, and `isGroup` is
  `chatId < 0` (Telegram group and supergroup ids are negative).

## Plugin: `dsh-telegram/schedule`

Files:

- `src/schedule-plugin.ts`: plugin shell. Exports `name = 'dsh-telegram-schedule'`,
  `Config`, `apply`. `apply` validates the config at load (same pattern as the
  idle plugin), then `ctx.inject(['telegram', 'tools'], ...)` starts the store,
  the timer and the tools.
- `src/schedule-store.ts`: loads and saves `schedule.json`. Every operation
  runs through one FIFO queue; a save writes a temp file and renames it.
- `src/schedule.ts`: pure logic: building records from tool input, permission
  checks, picking due reminders, advancing a recurring record.
- `src/schedule-tools.ts`: the four tools.

Config (bundle row; the profile does not restate it):

```yaml
- id: telegram-schedule
  name: dsh-telegram/schedule
  config:
    timeZone: Asia/Ho_Chi_Minh
    maxPerChat: 20
```

`timeZone` must be a valid IANA zone (checked at load); `maxPerChat` is at
least 1.

Stored reminder:

```ts
interface Reminder {
  chatId: number
  creator: { id: number; name: string }
  mode: 'message' | 'agent'
  record: ScheduleRecord   // dsh-schedule: id, kind, title, prompt, scheduledAt and the rule
}
```

`schedule.json` holds `{ version: 1, reminders: Reminder[] }`. Only active
reminders are stored: a delivered one-shot is removed.

## Tools

Registered once on the plugin context with `ctx.tools.register`, so they live
and die with the plugin and the tool list stays stable across turns. Each call
resolves the chat with `telegram.chatOf(exec.agent.id)` and the sender with
`telegram.turnOf(chatId)`; with no chat or no turn it returns
`code: 'no_chat'`.

- `schedule_create`: `title` (non-empty, at most 120 characters), `prompt`
  (non-empty), `mode` (`message` default, or `agent`), and exactly one of
  `after_seconds`, `at`, `every_seconds` (at least 60), `daily`
  (`{ time, time_zone? }`), `weekly` (`{ time, time_zone?, weekdays }`),
  `cron` (`{ expression, time_zone? }`). A missing `time_zone` uses
  `config.timeZone`. `at` takes the `dsh-schedule` `AtInput`.
- `schedule_list`: the chat's reminders.
- `schedule_update`: `id` plus any of `title`, `prompt`, and one timing
  selector except `after_seconds`; a timing change re-anchors from now.
  `mode` cannot change.
- `schedule_delete`: `id`.

Results are JSON text. A reminder view has `id`, `kind`, `mode`, `title`,
`prompt`, `scheduledAt` (ISO), `creator`, and the rule fields (`everySeconds`,
`time`, `timeZone`, `weekdays`, `expression`) for its kind. Errors return
`{ code, message }`:

| Code | When |
|---|---|
| `invalid_rule` | A `dsh-schedule` input error (bad time, zone, weekday, cron field, interval below 60 s, `at` not in the future), zero or several selectors, blank title or prompt. |
| `forbidden` | Update or delete by someone other than the creator or a super admin; `agent` mode by a non super admin. |
| `schedule_not_found` | No reminder with that id in this chat (another chat's reminder counts as missing). |
| `limit_reached` | The chat already has `maxPerChat` reminders. |
| `no_chat` | Called outside a chat turn (e.g. from a subagent). |
| `storage_failed` | The store could not be written; nothing changed. |

## Timer and delivery

One `setTimeout` targets the earliest `scheduledAt`. Delays above the Node
timer limit (2^31 - 1 ms) are split. The timer is recomputed after every
change and cleared when the plugin stops. Each firing reads `Date.now()` and
handles every reminder with `scheduledAt <= now`, one at a time, in
`scheduledAt` order:

1. Re-read the reminder from the store; skip it if it was deleted or changed.
2. Persist the next state: delete a one-shot; for a recurring reminder,
   `resolveRecurringOccurrence(record, now)` gives `nextScheduledAt`, which is
   stored (a reminder whose rule is exhausted is deleted).
3. Deliver:
   - `message`: `api.sendMessage(chatId, '\u{23F0} ' + title + '\n' + prompt)`
     as plain text, then a chat-log entry with `bot: true`.
   - `agent`: if the creator is no longer in `superAdmins`, delete the
     reminder and send one line saying it was stopped. Otherwise
     `telegram.prompt(chatId, { text, sender })`, where `sender` is the
     creator and `text` is
     `<scheduled_reminder title="..." created_by="...">instruction</scheduled_reminder>`
     with the attribute values escaped.
4. Log `dsh-telegram: chat <id> reminder <id> -> message|agent`.

At start (each time the `telegram` service appears) the store is loaded and
the timer set, so overdue reminders fire on the first tick.

## Error handling

- Telegram send failure (bot removed, chat gone): warning logged, no retry;
  a recurring reminder waits for its next occurrence.
- `schedule.json` unreadable or invalid at load: error logged, the inner
  plugin fails and does not start, the file is left untouched. The bot keeps
  running without reminder tools.
- Store write failure: the tool returns `storage_failed`; memory keeps the
  previous state.
- A failing reminder never stops the timer or affects another reminder.

## Testing (vitest)

- `schedule.ts`: building each of the six kinds, `time_zone` defaulting,
  selector count errors, the permission matrix (creator, super admin, other
  member; `agent` mode), the per-chat limit, due selection and ordering,
  recurring advance, one-shot removal, missed-occurrence catch-up at start.
- `schedule-store.ts`: round trip through a temp directory, atomic write
  (no partial file on failure), invalid file rejected without overwriting.
- `schedule-tools.ts`: each tool against a fake service and a real store,
  including every error code.
- Delivery: `message` sends and logs; `agent` calls `prompt()` with the
  creator as sender; a creator who lost super admin stops the reminder; a
  failed send is logged and the next occurrence stays scheduled.
- Core: `runChatTurn` without a reply target, `prompt()` queued behind a
  running turn and emitting `telegram/turn`, `chatOf` returning `undefined`
  for an unknown agent; existing `handleMessage` tests unchanged.
- Plugin lifecycle, as in `idle-plugin.spec.ts`: inert without `telegram`,
  timer cleared on revoke, invalid config rejected at load.
- Profile: the bundle carries the `telegram-schedule` row.

## Out of scope

- Delivery history and receipts.
- A `/reminders` command for users.
- Managing another chat's reminders.
- Importing reminders from `dsh-schedule`.
- Retrying a failed delivery.
