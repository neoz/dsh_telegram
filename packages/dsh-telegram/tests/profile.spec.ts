import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

/** Mirrors the dsh loader (JSON schema plus `!!js`); the tag holds a JavaScript expression, kept as source text here. */
const schema = yaml.JSON_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (source: string) => ({ js: source }) })])
interface Row { id?: string; name?: string; config?: Record<string, any>; insert?: Row[] }

async function rows(path: string): Promise<Row[]> {
  return yaml.load(await readFile(new URL(path, import.meta.url), 'utf8'), { schema }) as Row[]
}
/** The bundle declares its rows under `insert`; the profile restates them at the top level. */
function row(list: Row[], id: string): Row {
  return (list.find(r => r.id === id) ?? list.flatMap(r => r.insert ?? []).find(r => r.id === id))!
}
function telegramIdle(list: Row[]): Record<string, any> {
  return row(list, 'telegram-idle').config!
}
function evalJs(value: { js: string }, env: Record<string, string>): unknown {
  return new Function('process', `return (${value.js})`)({ env })
}

describe('profile patch', () => {
  it('shares the system-prompt persona with idle engagement', async () => {
    const profile = await rows('../../../profile/telegram/cordis.patch.yml')
    const persona = profile.find(r => r.id === 'system-prompt')!.config!.personaPrefix
    expect(typeof persona).toBe('string')
    expect(telegramIdle(profile).persona).toBe(persona)
  })

  it('maps idle env vars, keeping negative supergroup ids', async () => {
    for (const path of ['../../../profile/telegram/cordis.patch.yml', '../cordis.patch.yml']) {
      const config = telegramIdle(await rows(path))
      expect(evalJs(config.chatIds, { TELEGRAM_IDLE_CHATS: '-1001234567890, 42,' })).toEqual([-1001234567890, 42])
      expect(evalJs(config.chatIds, {})).toEqual([])
      expect(evalJs(config.enabled, { TELEGRAM_IDLE_ENABLED: 'true' })).toBe(true)
      expect(evalJs(config.enabled, {})).toBe(false)
    }
  })

  it('tunes idle timing from replayed chat logs', async () => {
    for (const path of ['../../../profile/telegram/cordis.patch.yml', '../cordis.patch.yml']) {
      const config = telegramIdle(await rows(path))
      const { idleMinutes, minNewMessages, chance, maxPerBurst, slotGapMinutes, maxPerDay } = config
      expect({ idleMinutes, minNewMessages, chance, maxPerBurst, slotGapMinutes, maxPerDay })
        .toEqual({ idleMinutes: 10, minNewMessages: 5, chance: 1, maxPerBurst: 4, slotGapMinutes: 10, maxPerDay: 24 })
    }
  })

  it('keeps idle off the telegram row and mounts the idle plugin', async () => {
    for (const path of ['../../../profile/telegram/cordis.patch.yml', '../cordis.patch.yml']) {
      expect(row(await rows(path), 'telegram').config).not.toHaveProperty('idle')
    }
    expect(row(await rows('../cordis.patch.yml'), 'telegram-idle').name).toBe('dsh-telegram/idle')
  })

  it('gives the agent a clock in the local zone, since Telegram sends no browser zone', async () => {
    const clock = row(await rows('../cordis.patch.yml'), 'time-context')
    expect(clock.name).toBe('@deepseek-ai/dsh-time-context')
    expect(clock.config).toEqual({ timeZone: 'Asia/Ho_Chi_Minh' })
  })

  it('mounts the reminder plugin with the local zone', async () => {
    const reminders = row(await rows('../cordis.patch.yml'), 'telegram-schedule')
    expect(reminders.name).toBe('dsh-telegram/schedule')
    expect(reminders.config).toEqual({ timeZone: 'Asia/Ho_Chi_Minh', maxPerChat: 20 })
  })

  it('keeps both idle rows valid for the burst schema', async () => {
    const { Config } = await import('../src/idle/index.ts')
    const resolve = (value: any): any => (value !== null && typeof value === 'object' && 'js' in value
      ? evalJs(value, { TELEGRAM_IDLE_ENABLED: 'true', TELEGRAM_IDLE_CHATS: '-100' })
      : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)])) : value)
    for (const path of ['../../../profile/telegram/cordis.patch.yml', '../cordis.patch.yml']) {
      const config = Config(resolve(telegramIdle(await rows(path))))
      expect(config).toMatchObject({ enabled: true, chatIds: [-100], hotWindowMinutes: 5, burstGapMinutes: 15, maxPerBurst: 4, slotGapMinutes: 10 })
      expect(config).not.toHaveProperty('checkIntervalMinutes')
    }
  })
})
