import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TurnContext } from '../../src/sessions/agents.ts'
import { SkillStore } from '../../src/skills/store.ts'
import { createSkillTools, registerSkillTools } from '../../src/skills/tools.ts'

let dir: string
let skills: SkillStore
let turn: TurnContext | undefined
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skill-tools-'))
  skills = new SkillStore(join(dir, 'skills'), async (_repo, dest) => {
    await new SkillStore(dest).save('pdf', [{ path: 'SKILL.md', content: SKILL }])
  })
  turn = undefined
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const exec = { callId: 'c', name: '', arguments: {}, signal: new AbortController().signal, deferContext() {}, concludeTurn() {} } as never
const SKILL = '---\nname: pdf\ndescription: Read PDFs\n---\nbody'
const admin = { id: '7', name: 'Ann' }

function tools() {
  return createSkillTools({ skills, currentTurn: () => turn })
}

describe('skill tools', () => {
  it('lets a super admin save, import and delete skills from a private chat', async () => {
    turn = { sender: admin, isGroup: false, isSuperAdmin: true }
    const { save, delete: del, import: imp } = tools()
    expect([save.name, del.name, imp.name]).toEqual(['skill_save', 'skill_delete', 'skill_import'])
    expect(await save.execute({ name: 'pdf', files: [{ path: 'SKILL.md', content: SKILL }] }, exec)).toBe('Created skill pdf: SKILL.md')
    expect(await imp.execute({ repo: 'github.com/o/r' }, exec)).toBe('Skipped, already exists (pass overwrite to replace): pdf')
    expect(await imp.execute({ repo: 'github.com/o/r', overwrite: true }, exec)).toBe('Imported: pdf')
    expect(await imp.execute({ repo: 'github.com/o/r', skills: ['x'] }, exec)).toBe('Not found in the repository: x')
    expect(await del.execute({ name: 'pdf' }, exec)).toBe('Deleted skill pdf')
  })

  it('refuses members, group chats, and calls outside a turn', async () => {
    const { save, delete: del, import: imp } = tools()
    const args = { name: 'pdf', files: [{ path: 'SKILL.md', content: SKILL }] }
    await expect(save.execute(args, exec)).rejects.toThrow('only super admins can edit skills')
    turn = { sender: { id: '9', name: 'Bob' }, isGroup: false, isSuperAdmin: false }
    await expect(del.execute({ name: 'pdf' }, exec)).rejects.toThrow('only super admins can edit skills')
    turn = { sender: admin, isGroup: true, isSuperAdmin: true }
    await expect(imp.execute({ repo: 'github.com/o/r' }, exec)).rejects.toThrow(/private chat/)
    expect(await readdir(dir)).toEqual([])
  })

  it('registers each tool on the agent context', () => {
    const registered: string[] = []
    registerSkillTools({ tools: { register: t => { registered.push(t.name); return () => {} } }, effect: fn => { fn() } }, { skills, currentTurn: () => turn })
    expect(registered).toEqual(['skill_save', 'skill_delete', 'skill_import'])
  })
})
