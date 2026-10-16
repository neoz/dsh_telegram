import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '../sessions/index.ts'
import { SkillStore } from './store.ts'
import { registerSkillTools } from './tools.ts'

export interface SkillsConfig {
  root?: string
}

export const Config: z<SkillsConfig> = z.object({
  root: z.string().description('Skill library directory; defaults to the user root that dsh-skill-filesystem scans, $DSH_AGENTS_HOME/skills'),
})

/** Cordis plugin name. */
export const name = 'dsh-chat-skills'
export const inject = ['chatAgents']

export function apply(ctx: Context, config: SkillsConfig): void {
  const skills = new SkillStore(config.root ?? join(process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'), 'skills'))
  ctx.on('chat/agent', (agentCtx, key) => {
    registerSkillTools(agentCtx, { skills, currentTurn: () => ctx.chatAgents.turnOf(key) })
  })
}
