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
const env = { ZALO_BOT_TOKEN: 't', ZALO_ALLOW_FROM: 'a1, b2,', ZALO_SUPER_ADMINS: 'a1' }

describe('profile patch', () => {
  it('maps env vars to a valid zalo row with string ids', async () => {
    for (const path of PATHS) {
      const config = Config(resolve(row(await rows(path), 'zalo').config, env))
      expect(config).toMatchObject({ botToken: 't', allowFrom: ['a1', 'b2'], superAdmins: ['a1'], workspaceRoot: '/workspace', dataDir: '/data', model: 'deepseek-flash' })
    }
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
