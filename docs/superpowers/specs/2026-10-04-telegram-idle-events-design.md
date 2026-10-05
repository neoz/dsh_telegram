# dsh-telegram: event-driven idle engagement

Date: 2026-10-04
Status: approved design, pending implementation plan

## Goal

Idle engagement (`dsh-telegram/idle`) checks each group on a fixed 10-minute
tick, so it joins a hot conversation 10 to 20 minutes late, often after it has
died down. Replaying 2026-10-04's chat log showed a 40-minute burst whose first
eligible tick came 10 minutes in. This change makes idle react to each new
message instead, so it decides within one or two minutes of a group heating
up.

By default the bot still joins a burst at most once and the daily cap stays,
so it gets more timely, not more frequent. Joining more than once per burst is
a configuration choice (`maxPerBurst`).

## Decisions

| Topic | Decision |
|---|---|
| Trigger | A new core event, `telegram/message`, fired for every line appended to a chat log. Idle evaluates on each human message. The interval timer goes away. |
| Hot | At least `minNewMessages` human messages in the last `hotWindowMinutes`, from at least two different senders. Two is fixed, not configurable. |
| Burst | A run of human messages with no gap longer than `burstGapMinutes`; a longer gap starts a new burst. |
| Slots | `maxPerBurst` engagements per burst (default 1). A second slot also waits `slotGapMinutes` after the previous roll. |
| Chance | Rolled once per slot. Hit or miss, the roll uses the slot; a slot leads to at most one LLM call, and an LLM `skip` uses it too. |
| State | Kept in memory per allowlisted chat. Seeded from the chat log once at start, then fed by events. |
| Unchanged | `maxPerDay`, quiet hours, the LLM prompt and output validation, the in-queue re-check, delivery, `telegram/turn`. |

## Core: `telegram/message`

`ChatLog` takes an optional listener:

```ts
constructor(dir: string, onAppend?: (chatId: number, entry: ChatLogEntry) => void)
```

`append` calls it after the line is written. A failed write throws as before
and calls nothing. `src/index.ts` builds the chat log with
`onAppend: (chatId, entry) => ctx.emit('telegram/message', chatId, entry)`, so
every writer emits the event: logged and handled messages, bot replies, idle
replies, and `message` reminders written through `telegram.chatLog`.

`src/service.ts` declares it next to `telegram/turn`:

```ts
interface Events {
  /** A line was appended to a chat's log (human or bot), after it was written. */
  'telegram/message'(chatId: number, entry: ChatLogEntry): void
}
```

Listeners run synchronously through `ctx.emit`. Cordis 4.0.4 does not isolate
listeners, so the core wraps the emit (`forwardAppends` in `src/index.ts`): a
throwing listener only logs a warning and never fails the write.

There is no `busy` verdict: human lines are written by a dispatcher task, so the
chat's queue is always busy when the event fires. The engagement is enqueued
behind that task, and the in-queue re-check cancels it if a turn started. Code that builds a
`ChatLog` without a listener behaves as before.

## Idle: per-chat state

```ts
interface ChatIdleState {
  /** Entries of the last max(hotWindowMinutes, burstGapMinutes, idleMinutes) minutes, and never fewer than the newest contextMessages entries; oldest first. */
  recent: ChatLogEntry[]
  burst: { since: number; lastHumanAt: number; slotsUsed: number }
  lastTurnAt: number
  day: string
  count: number
  reacted: number[]
  /** Last check verdict recorded in this burst, to skip repeats. */
  lastVerdict?: CheckVerdict
}
```

- At start, `recent` is seeded from `chatLog.readAll` once per chat. Lines that
  arrive while a chat is being seeded are held and replayed afterwards, minus
  those the seed already read, so none is lost or counted twice.
- Live lines are timed by arrival (host clock); seeded lines by their logged
  time. A Telegram clock that differs from the host's does not skew the hot
  window, and an out-of-order line never moves `burst.lastHumanAt` backwards.
- `lastTurnAt` is still set from `telegram/turn`.
- `lastAttemptAt` is removed; slots replace it.

## Idle: evaluation on each human message

On `telegram/message` for an allowlisted chat:

1. Append the entry to `recent` and drop entries older than the retention
   window, keeping at least the newest `contextMessages` entries so the LLM
   gets as much context as today. Bot entries stop here: they only feed the answered-message
   set and the LLM context.
2. For a human entry, if its time is more than `burstGapMinutes` after
   `burst.lastHumanAt`, start a new burst
   (`since = now, slotsUsed = 0, lastVerdict = undefined`). Then set
   `lastHumanAt`.
3. Evaluate. The first condition that blocks wins:

| Verdict | Blocks when |
|---|---|
| `not_hot` | Fewer than `minNewMessages` human messages in the last `hotWindowMinutes`. |
| `one_speaker` | Enough messages, but from a single sender. |
| `not_idle` | Someone addressed the bot within the last `idleMinutes` (`lastTurnAt`). The bot's own replies, idle reactions and reminder messages do not count. |
| `burst_spent` | `burst.slotsUsed >= maxPerBurst`. |
| `slot_gap` | A later slot rolled within `slotGapMinutes` of the previous roll, whether that one engaged, missed or was skipped. |
| `nothing_pickable` | No human message in the last `hotWindowMinutes` that the bot has not answered (`handled`, or the `reply_to` of a bot entry) or reacted to. |
| `daily_cap` | `maxPerDay` engagements today, by calendar day in `timezone`. |
| `quiet_hours` | The current hour in `timezone` is in `[quietHours.from, quietHours.to)`. |
| `chance_miss` / `go` | `slotsUsed++`, then `random() < chance`. |

4. On `go`, enqueue the engagement task on the chat's queue. Inside the task,
   re-run the evaluation without the busy check and without rolling or using a
   slot. If anything now blocks (for example the bot was addressed meanwhile),
   record `cancelled` and stop. Otherwise call the LLM with the newest
   `contextMessages` entries of `recent`, with pickable messages marked
   `(open)`, and deliver exactly as today. A `react` or `reply` counts
   toward `maxPerDay`, and a reaction is remembered so it is not picked again.

The evaluation is a pure function of the state, `now`, the config and `random`,
so it is tested without timers.

## Configuration

| Field | Default | Note |
|---|---|---|
| `hotWindowMinutes` | 5 | New, min 1. Also the window for pickable messages, replacing `checkIntervalMinutes`. |
| `burstGapMinutes` | 15 | New, min 1. |
| `maxPerBurst` | 1 | New, min 1. |
| `slotGapMinutes` | 5 | New, min 1. Minimum gap between two slots of one burst. |
| `chance` | 0.3 | Now per slot. The bundle and profile use 0.7. |
| `checkIntervalMinutes` | removed | No timer. |
| `enabled`, `chatIds`, `idleMinutes`, `minNewMessages`, `maxPerDay`, `quietHours`, `timezone`, `contextMessages`, `persona` | unchanged | `idleMinutes` is how long nobody must have addressed the bot. |

The bundle and profile rows set `idleMinutes: 10`, `minNewMessages: 5`,
`chance: 0.7`, `maxPerBurst: 2` and `maxPerDay: 10`: a group with about one hot
burst a day missed it half the time at `chance: 0.5` with one slot; two slots at
0.7 join about 91% of bursts that last past `slotGapMinutes`.

## Decision log

`idle-decisions.jsonl` keeps its format:

- `start` lists the new config fields and is written once every window is
  seeded, marking idle as live.
- `check` is recorded for every verdict except `not_hot`, and only when it
  differs from the chat's `lastVerdict` in the current burst, except `go`
  and `chance_miss`, which are recorded every time because each one is a
  slot's roll. A record has
  `{ ts, chatId, event: "check", verdict, fresh, speakers, pickable, burstSince, slotsUsed }`.
- `decision` is unchanged (`react`, `reply`, `skip`, `cancelled`, `error`).

## Error handling

- Seeding a chat's window fails (corrupted chat log): warning logged, the chat
  starts with an empty window, and other chats are unaffected.
- An exception while evaluating a message is caught and logged in the
  listener. The chat-log write and other chats are unaffected.
- Queued-task, LLM and Telegram failures are handled as today.
- The dispatcher notes a turn (`telegram/turn`) as soon as an addressed message
  arrives, not only when it is handled, so an idle task already queued ahead of
  it sees the turn in its re-check and cancels.
- When the plugin stops, Cordis removes the listeners and `lifetime` aborts
  queued and running tasks, as today.
- Known limitation: a restart in the middle of a burst resets `slotsUsed` (and,
  as today, the daily counter), so the bot may join that burst once more.

## Testing (vitest)

- `ChatLog`: `onAppend` is called with the chat id and entry after a write,
  and not on a failed write.
- Evaluation (pure):
  - each verdict in the table, including `one_speaker` and `burst_spent`;
  - a new burst after `burstGapMinutes`;
  - one chance roll per slot, a miss using the slot;
  - `maxPerBurst: 2` allowing a second engagement after `slotGapMinutes` while
    the burst stays hot;
  - bot entries never trigger an evaluation.
- Event-driven scheduler (fake queue, real `ChatLog` in a temp directory):
  - reaching the threshold enqueues at once, with no timer;
  - a busy chat records `busy`;
  - the in-queue re-check cancels when the bot was addressed meanwhile;
  - `check` records are not repeated while the verdict stays the same;
  - the window is seeded at start;
  - a corrupted chat log in one chat leaves the others working.
- Plugin: lifecycle as today; an entry written through `telegram.chatLog`
  (which emits `telegram/message`) leads to a queued task.
- Profile: the bundle and profile idle rows still validate against the new
  schema.

## Known effects

- Idle means only that nobody addressed the bot for `idleMinutes`. After the
  bot sends a `message` reminder into a hot group, it may join that
  conversation right away.

## Out of scope

- A deliberate delay before joining (waiting for the group to pause).
- Persisting burst state across restarts.
- A configurable minimum number of speakers.
