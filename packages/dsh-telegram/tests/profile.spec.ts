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
  return row(list, 'chat-idle').config!
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
      expect(evalJs(config.chatKeys, { TELEGRAM_IDLE_CHATS: '-1001234567890, 42, 0, x,' })).toEqual(['telegram:-1001234567890', 'telegram:42'])
      expect(evalJs(config.chatKeys, {})).toEqual([])
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

  it('keeps idle off the telegram row and mounts the shared idle plugin', async () => {
    for (const path of ['../../../profile/telegram/cordis.patch.yml', '../cordis.patch.yml']) {
      expect(row(await rows(path), 'telegram').config).not.toHaveProperty('idle')
    }
    const bundle = await rows('../cordis.patch.yml')
    expect(row(bundle, 'chat-idle').name).toBe('dsh-chat/idle')
    const names = bundle.flatMap(r => r.insert ?? []).map(r => r.name)
    expect(names).not.toContain('dsh-telegram/idle')
    expect(names).not.toContain('dsh-telegram/schedule')
  })

  it('gives the agent a clock in the local zone, since Telegram sends no browser zone', async () => {
    const clock = row(await rows('../cordis.patch.yml'), 'time-context')
    expect(clock.name).toBe('@deepseek-ai/dsh-time-context')
    expect(clock.config).toEqual({ timeZone: 'Asia/Ho_Chi_Minh' })
  })

  it('mounts the reminder plugin with the local zone', async () => {
    const reminders = row(await rows('../cordis.patch.yml'), 'chat-schedule')
    expect(reminders.name).toBe('dsh-chat/schedule')
    expect(reminders.config).toEqual({ timeZone: 'Asia/Ho_Chi_Minh', maxPerChat: 20 })
  })

  it('keeps both idle rows valid for the burst schema', async () => {
    const { Config } = await import('dsh-chat/idle')
    const resolve = (value: any): any => (value !== null && typeof value === 'object' && 'js' in value
      ? evalJs(value, { TELEGRAM_IDLE_ENABLED: 'true', TELEGRAM_IDLE_CHATS: '-100' })
      : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)])) : value)
    for (const path of ['../../../profile/telegram/cordis.patch.yml', '../cordis.patch.yml']) {
      const config = Config(resolve(telegramIdle(await rows(path))))
      expect(config).toMatchObject({ enabled: true, chatKeys: ['telegram:-100'], hotWindowMinutes: 5, burstGapMinutes: 15, maxPerBurst: 4, slotGapMinutes: 10 })
      expect(config).not.toHaveProperty('checkIntervalMinutes')
    }
  })
})

describe('dsh-chat rows', () => {
  const ids = ['chat-migrate', 'chat-log', 'chat-memory', 'chat-sessions', 'chat-history', 'chat-retention']

  it('inserts every dsh-chat plugin before the bot row', async () => {
    const list = await rows('../cordis.patch.yml')
    const inserted = list.flatMap(r => r.insert ?? []).map(r => r.id)
    for (const id of ids) expect(inserted.indexOf(id)).toBeGreaterThanOrEqual(0)
    for (const id of ids) expect(inserted.indexOf(id)).toBeLessThan(inserted.indexOf('telegram'))
    for (const id of ids) expect(row(list, id).name).toBe(`dsh-chat/${id.slice('chat-'.length)}`)
  })

  it('maps the old env vars to the migrate and sessions rows', async () => {
    const list = await rows('../cordis.patch.yml')
    const migrateRow = row(list, 'chat-migrate').config!
    expect(evalJs(migrateRow.dataDir, { DSH_TELEGRAM_DATA: '/x' })).toBe('/x')
    expect(evalJs(migrateRow.dataDir, {})).toBe('/data')
    expect(evalJs(migrateRow.workspaceRoot, {})).toBe('/workspace')
    expect(migrateRow.legacyChannel).toBe('telegram')
    expect(evalJs(row(list, 'chat-sessions').config!.model, {})).toBe('deepseek-flash')
    expect(evalJs(row(list, 'chat-sessions').config!.model, { DSH_MODEL: 'm2' })).toBe('m2')
  })

  it('keeps paths and model off the bot row', async () => {
    for (const path of ['../../../profile/telegram/cordis.patch.yml', '../cordis.patch.yml']) {
      const config = row(await rows(path), 'telegram').config!
      for (const key of ['dataDir', 'workspaceRoot', 'model']) expect(config).not.toHaveProperty(key)
    }
  })

  it('lists dsh-chat as a profile bundle before the adapter', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../../profile/telegram/package.json', import.meta.url), 'utf8'))
    const bundles: string[] = pkg.dsh.profile.bundles
    expect(bundles.indexOf('dsh-chat')).toBeGreaterThanOrEqual(0)
    expect(bundles.indexOf('dsh-chat')).toBeLessThan(bundles.indexOf('dsh-telegram'))
  })
})

describe('chat router row', () => {
  it('maps Telegram ids and usernames to user keys', async () => {
    const config = row(await rows('../cordis.patch.yml'), 'chat').config!
    expect(evalJs(config.allowFrom, { TELEGRAM_ALLOW_FROM: '123, @Ann ,bob,' })).toEqual(['telegram:123', 'telegram:@ann', 'telegram:@bob'])
    expect(evalJs(config.superAdmins, { TELEGRAM_SUPER_ADMINS: '7, x, -3' })).toEqual(['telegram:7'])
    expect(evalJs(config.allowFrom, {})).toEqual([])
  })

  it('mounts the router before the bot and keeps the allowlist off the telegram row', async () => {
    const bundle = await rows('../cordis.patch.yml')
    const ids = bundle.flatMap(r => r.insert ?? []).map(r => r.id)
    expect(ids.indexOf('chat')).toBeLessThan(ids.indexOf('telegram'))
    expect(row(bundle, 'chat').name).toBe('dsh-chat')
    for (const path of ['../../../profile/telegram/cordis.patch.yml', '../cordis.patch.yml']) {
      const telegram = row(await rows(path), 'telegram').config!
      expect(telegram).not.toHaveProperty('allowFrom')
      expect(telegram).not.toHaveProperty('superAdmins')
    }
  })
})
