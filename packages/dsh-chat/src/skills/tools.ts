import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { TurnContext } from '../sessions/agents.ts'
import type { ImportReport, SkillStore } from './store.ts'

export interface SkillToolDeps {
  skills: SkillStore
  /** The turn running in this chat; tools use it to authorise library edits. */
  currentTurn: () => TurnContext | undefined
}

/** The skill library is shared by every chat: only a super admin may edit it, and only from a private chat. */
function assertSkillWrite(deps: SkillToolDeps): void {
  const turn = deps.currentTurn()
  if (turn?.isGroup) throw new Error('skills can only be edited from a private chat with the bot')
  if (turn === undefined || !turn.isSuperAdmin) throw new Error('only super admins can edit skills')
}

const text = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
} as const

function formatReport(r: ImportReport): string {
  const line = (label: string, items: string[]) => items.length === 0 ? [] : [`${label}: ${items.join(', ')}`]
  const lines = [
    ...line('Imported', r.imported),
    ...line('Skipped, already exists (pass overwrite to replace)', r.skipped),
    ...line('Not found in the repository', r.notFound),
    ...line('Invalid', r.invalid),
  ]
  return lines.length === 0 ? 'No skills found in the repository' : lines.join('\n')
}

export function createSkillSaveTool(deps: SkillToolDeps): ToolDefinition {
  return defineTool({
    name: 'skill_save',
    description: 'Create a skill in the shared skill library, or add and overwrite files of an existing one. A new skill must include SKILL.md with YAML frontmatter holding name (equal to the skill name) and description. Text files only; files under scripts/ become executable. Super admins only, from a private chat.',
    parameters: {
      name: { type: 'string', required: true, description: 'Kebab-case skill name' },
      files: {
        type: 'array',
        required: true,
        description: 'Files to write, paths relative to the skill directory',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'e.g. SKILL.md or scripts/run.sh' },
            content: { type: 'string', required: true },
          },
        },
      },
    },
    output: text,
    async execute(args) {
      assertSkillWrite(deps)
      return deps.skills.save(args.name, args.files)
    },
  })
}

export function createSkillDeleteTool(deps: SkillToolDeps): ToolDefinition {
  return defineTool({
    name: 'skill_delete',
    description: 'Delete a skill from the shared skill library, or only one of its files when path is given. Super admins only, from a private chat.',
    parameters: {
      name: { type: 'string', required: true, description: 'Kebab-case skill name' },
      path: { type: 'string', description: 'File inside the skill to delete instead of the whole skill' },
    },
    output: text,
    async execute(args) {
      assertSkillWrite(deps)
      return deps.skills.remove(args.name, args.path)
    },
  })
}

export function createSkillImportTool(deps: SkillToolDeps): ToolDefinition {
  return defineTool({
    name: 'skill_import',
    description: 'Import skills from a public GitHub repository into the shared skill library: every directory holding a SKILL.md, or only the named skills. Existing skills are kept unless overwrite is true. Super admins only, from a private chat.',
    parameters: {
      repo: { type: 'string', required: true, description: 'Repository link, e.g. github.com/owner/repo or github.com/owner/repo/tree/<branch-or-tag>' },
      skills: { type: 'array', items: { type: 'string' }, description: 'Skill names to import; omit to import all' },
      overwrite: { type: 'boolean', description: 'Replace skills that already exist (default false)' },
    },
    output: text,
    async execute(args) {
      assertSkillWrite(deps)
      const opts = { ...args.skills === undefined ? {} : { skills: args.skills }, ...args.overwrite === undefined ? {} : { overwrite: args.overwrite } }
      return formatReport(await deps.skills.importRepo(args.repo, opts))
    },
  })
}

export function createSkillTools(deps: SkillToolDeps): { save: ToolDefinition; delete: ToolDefinition; import: ToolDefinition } {
  return { save: createSkillSaveTool(deps), delete: createSkillDeleteTool(deps), import: createSkillImportTool(deps) }
}

interface ToolHost {
  tools: { register(tool: ToolDefinition): () => void }
  effect(fn: () => () => void, label?: string): void
}

/** Registers the skill tools on one chat's agent context; disposal unwinds them. */
export function registerSkillTools(agentCtx: ToolHost, deps: SkillToolDeps): void {
  for (const tool of Object.values(createSkillTools(deps))) {
    agentCtx.effect(() => agentCtx.tools.register(tool), `dsh-chat: ${tool.name}`)
  }
}
