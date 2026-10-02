import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

/** Mirrors the dsh loader (JSON schema plus `!!js`); the tag holds a JavaScript expression, kept as source text here. */
const schema = yaml.JSON_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (source: string) => ({ js: source }) })])
interface Row { id?: string; config?: Record<string, any>; insert?: Row[] }

async function rows(path: string): Promise<Row[]> {
  return yaml.load(await readFile(new URL(path, import.meta.url), 'utf8'), { schema }) as Row[]
}
/** The bundle declares the telegram row under `insert`; the profile restates it at the top level. */
function telegramIdle(list: Row[]): Record<string, any> {
  const row = list.find(r => r.id === 'telegram') ?? list.flatMap(r => r.insert ?? []).find(r => r.id === 'telegram')
  return row!.config!.idle
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
})
