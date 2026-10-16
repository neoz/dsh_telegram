import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSendFileTool } from '../src/tools.ts'
import { FakeTelegramApi } from './helpers/fake-api.ts'

let dir: string
let api: FakeTelegramApi
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'tools-'))); api = new FakeTelegramApi() })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const exec = { callId: 'c', name: '', arguments: {}, signal: new AbortController().signal, deferContext() {}, concludeTurn() {} } as never

function deps() {
  return { api: () => api, chatId: 5, workspaceDir: dir, maxUploadBytes: 100 }
}

describe('telegram_send_file', () => {
  it('sends an image as a photo and other files as documents', async () => {
    await writeFile(join(dir, 'pic.png'), 'png')
    await writeFile(join(dir, 'notes.txt'), 'txt')
    const tool = createSendFileTool(deps())
    expect(tool.name).toBe('telegram_send_file')
    expect(await tool.execute({ path: 'pic.png' }, exec)).toBe('Sent pic.png')
    expect(await tool.execute({ path: join(dir, 'notes.txt'), caption: 'here' }, exec)).toBe('Sent notes.txt')
    expect(api.callsTo('sendPhoto')).toHaveLength(1)
    const [, , opts] = api.callsTo('sendDocument')[0]!.args as [number, Buffer, { filename: string; caption?: string }]
    expect(opts).toMatchObject({ filename: 'notes.txt', caption: 'here' })
  })

  it('refuses paths outside the workspace and oversized files', async () => {
    await writeFile(join(dir, 'big.bin'), 'x'.repeat(200))
    await writeFile(join(tmpdir(), 'dsh-telegram-secret'), 'x')
    const tool = createSendFileTool(deps())
    await expect(tool.execute({ path: '../dsh-telegram-secret' }, exec)).rejects.toThrow(/outside/)
    await expect(tool.execute({ path: 'big.bin' }, exec)).rejects.toThrow(/exceeds/)
    await rm(join(tmpdir(), 'dsh-telegram-secret'), { force: true })
  })
})

describe('telegram_send_file across bot restarts', () => {
  it('sends through the bot running at call time', async () => {
    await writeFile(join(dir, 'notes.txt'), 'txt')
    let current: FakeTelegramApi | undefined = api
    const tool = createSendFileTool({ ...deps(), api: () => current })
    const restarted = new FakeTelegramApi()
    current = restarted
    await tool.execute({ path: 'notes.txt' }, exec)
    expect(api.callsTo('sendDocument')).toHaveLength(0)
    expect(restarted.callsTo('sendDocument')).toHaveLength(1)
  })

  it('fails clearly while the bot is not running', async () => {
    await writeFile(join(dir, 'notes.txt'), 'txt')
    const tool = createSendFileTool({ ...deps(), api: () => undefined })
    await expect(tool.execute({ path: 'notes.txt' }, exec)).rejects.toThrow('the Telegram bot is not running; try again shortly')
  })
})
