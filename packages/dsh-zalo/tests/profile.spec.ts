import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'

/** Mirrors the dsh loader (JSON schema plus `!!js`); the tag holds a JavaScript expression, kept as source text here. */
const schema = yaml.JSON_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (source: string) => ({ js: source }) })])
interface Row { id?: string; name?: string; config?: Record<string, any>; insert?: Row[] }
async function rows(path: string): Promise<Row[]> {
  return yaml.load(await readFile(new URL(path, import.meta.url), 'utf8'), { schema }) as Row[]
}
function row(list: Row[], id: string): Row {
  return (list.find(r => r.id === id) ?? list.flatMap(r => r.insert ?? []).find(r => r.id === id))!
}
const resolve = (value: any, env: Record<string, string>): any => (value !== null && typeof value === 'object' && 'js' in value
  ? new Function('process', `return (${value.js})`)({ env })
  : value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, env)])) : value)

const PATHS = ['../../../profile/zalo/cordis.patch.yml', '../cordis.patch.yml']
const env = { ZALO_BOT_TOKEN: 't', ZALO_ALLOW_FROM: 'a1, b2,', ZALO_SUPER_ADMINS: 'a1, s9' }

describe('profile patch', () => {
  it('maps env vars to a valid zalo row that leaves the allowlist to the router', async () => {
    for (const path of PATHS) {
      const raw = row(await rows(path), 'zalo').config!
      expect(raw).not.toHaveProperty('allowFrom')
      expect(raw).not.toHaveProperty('superAdmins')
      expect(Config(resolve(raw, env))).toMatchObject({ botToken: 't' })
    }
  })
  it('maps Zalo ids to user keys on the chat router row, mounted before the bot', async () => {
    const bundle = await rows('../cordis.patch.yml')
    const chat = row(bundle, 'chat')
    expect(chat.name).toBe('dsh-chat')
    // Super admins are always let in on Zalo, as before the router: their commands would be useless otherwise.
    expect(resolve(chat.config, env)).toEqual({ allowFrom: ['zalo:a1', 'zalo:b2', 'zalo:s9'], superAdmins: ['zalo:a1', 'zalo:s9'] })
    const ids = bundle.flatMap(r => r.insert ?? []).map(r => r.id)
    expect(ids.indexOf('chat')).toBeLessThan(ids.indexOf('zalo'))
  })
  it('mounts the plugin, its logger and a local clock', async () => {
    const bundle = await rows('../cordis.patch.yml')
    expect(row(bundle, 'zalo').name).toBe('dsh-zalo')
    expect(row(bundle, 'zalo-logger').name).toBe('dsh-zalo/logger')
    expect(row(bundle, 'time-context').config).toEqual({ timeZone: 'Asia/Ho_Chi_Minh' })
  })
  it('never tells the agent about a send-file tool Zalo does not have', async () => {
    for (const path of PATHS) {
      expect(JSON.stringify(row(await rows(path), 'system-prompt').config)).not.toMatch(/send_file/)
    }
  })
})

describe('dsh-chat rows', () => {
  const ids = ['chat-migrate', 'chat-log', 'chat-memory', 'chat-sessions', 'chat-history', 'chat-retention']

  it('inserts every dsh-chat plugin before the bot row', async () => {
    const list = await rows('../cordis.patch.yml')
    const inserted = list.flatMap(r => r.insert ?? []).map(r => r.id)
    for (const id of ids) expect(inserted.indexOf(id)).toBeGreaterThanOrEqual(0)
    for (const id of ids) expect(inserted.indexOf(id)).toBeLessThan(inserted.indexOf('zalo'))
    for (const id of ids) expect(row(list, id).name).toBe(`dsh-chat/${id.slice('chat-'.length)}`)
  })

  it('maps the old env vars to the migrate and sessions rows', async () => {
    const list = await rows('../cordis.patch.yml')
    expect(resolve(row(list, 'chat-migrate').config, { DSH_ZALO_DATA: '/x' })).toEqual({ dataDir: '/x', workspaceRoot: '/workspace', legacyChannel: 'zalo' })
    expect(resolve(row(list, 'chat-migrate').config, {})).toMatchObject({ dataDir: '/data' })
    expect(resolve(row(list, 'chat-sessions').config, {})).toEqual({ model: 'deepseek-flash' })
  })

  it('keeps paths and model off the bot row', async () => {
    for (const path of PATHS) {
      const config = row(await rows(path), 'zalo').config!
      for (const key of ['dataDir', 'workspaceRoot', 'model']) expect(config).not.toHaveProperty(key)
    }
  })

  it('lists dsh-chat as a profile bundle before the adapter', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../../profile/zalo/package.json', import.meta.url), 'utf8'))
    const bundles: string[] = pkg.dsh.profile.bundles
    expect(bundles.indexOf('dsh-chat')).toBeGreaterThanOrEqual(0)
    expect(bundles.indexOf('dsh-chat')).toBeLessThan(bundles.indexOf('dsh-zalo'))
  })
})
