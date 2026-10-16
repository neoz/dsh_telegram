import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { writeFileAtomic } from '../json-file.ts'

export interface SkillFile {
  path: string
  content: string
}

export interface GithubRepo {
  url: string
  ref?: string
}

export interface ImportReport {
  imported: string[]
  skipped: string[]
  notFound: string[]
  invalid: string[]
}

/** Downloads `repo` into the empty directory `dest`. */
export type RepoFetcher = (repo: GithubRepo, dest: string) => Promise<void>

const SKILL_FILE = 'SKILL.md'
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const REPO = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/(.+?))?\/?$/

export function assertSkillName(name: string): void {
  if (!NAME.test(name)) throw new Error(`invalid skill name "${name}": use kebab-case, e.g. pdf-tools`)
}

/** Reads `name` and `description` from SKILL.md frontmatter; throws unless both are present. */
export function parseSkillMeta(text: string): { name: string; description: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  const field = (key: string) => fm && new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2')
  const name = field('name')
  const description = field('description')
  if (!name) throw new Error('SKILL.md needs YAML frontmatter with a name field')
  if (!description) throw new Error('SKILL.md frontmatter needs a non-empty description field')
  return { name, description }
}

export function parseGithubRepo(input: string): GithubRepo {
  const m = REPO.exec(input.trim())
  if (!m) throw new Error(`not a GitHub repository link: ${input}`)
  return m[3] === undefined ? { url: `https://github.com/${m[1]}/${m[2]}.git` } : { url: `https://github.com/${m[1]}/${m[2]}.git`, ref: m[3] }
}

const run = promisify(execFile)

/** Shallow clone of a public repository; a credential prompt fails instead of hanging. */
export const gitFetch: RepoFetcher = async (repo, dest) => {
  const branch = repo.ref === undefined ? [] : ['--branch', repo.ref]
  await run('git', ['clone', '--depth', '1', ...branch, '--', repo.url, dest], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 120_000 })
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

/** Every directory under `dir` holding a SKILL.md, without descending into a found skill. */
async function findSkillDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  if (entries.some(e => e.isFile() && e.name === SKILL_FILE)) return [dir]
  const found: string[] = []
  for (const e of entries) {
    if (e.isDirectory() && e.name !== '.git') found.push(...await findSkillDirs(join(dir, e.name)))
  }
  return found
}

/** The shared skill library: one directory per skill, read by dsh-skill-filesystem. */
export class SkillStore {
  constructor(readonly root: string, private readonly fetchRepo: RepoFetcher = gitFetch) {}

  private dirOf(name: string): string {
    assertSkillName(name)
    return join(this.root, name)
  }

  private fileOf(dir: string, path: string): string {
    const file = resolve(dir, path)
    if (isAbsolute(path) || !file.startsWith(dir + sep)) throw new Error(`file path must stay inside the skill: ${path}`)
    return file
  }

  /** Writes `files` into skill `name`, creating it when new; SKILL.md goes last so the catalog sees a complete skill. */
  async save(name: string, files: SkillFile[]): Promise<string> {
    const dir = this.dirOf(name)
    const targets = files.map(f => ({ ...f, file: this.fileOf(dir, f.path) }))
    const skillMd = targets.find(t => t.file === join(dir, SKILL_FILE))
    if (skillMd) {
      const meta = parseSkillMeta(skillMd.content)
      if (meta.name !== name) throw new Error(`SKILL.md name "${meta.name}" must equal the skill name "${name}"`)
    }
    const created = !await exists(join(dir, SKILL_FILE))
    if (created && !skillMd) throw new Error(`skill "${name}" does not exist yet: include ${SKILL_FILE}`)
    for (const t of [...targets.filter(t => t !== skillMd), ...(skillMd ? [skillMd] : [])]) {
      await writeFileAtomic(t.file, t.content)
      if (relative(dir, t.file).startsWith(`scripts${sep}`)) await chmod(t.file, 0o755)
    }
    return `${created ? 'Created' : 'Updated'} skill ${name}: ${files.map(f => f.path).join(', ')}`
  }

  /** Deletes the whole skill, or one of its files other than SKILL.md. */
  async remove(name: string, path?: string): Promise<string> {
    const dir = this.dirOf(name)
    if (!await exists(join(dir, SKILL_FILE))) throw new Error(`no skill named "${name}"`)
    if (path === undefined) {
      await rm(dir, { recursive: true, force: true })
      return `Deleted skill ${name}`
    }
    const file = this.fileOf(dir, path)
    if (file === join(dir, SKILL_FILE)) throw new Error(`delete the whole skill instead of its ${SKILL_FILE}`)
    if (!await exists(file)) throw new Error(`skill "${name}" has no file ${path}`)
    await rm(file, { recursive: true, force: true })
    return `Deleted ${path} from skill ${name}`
  }

  /** Copies every skill of a GitHub repository, or only the named ones, into the library. */
  async importRepo(link: string, opts: { skills?: string[]; overwrite?: boolean } = {}): Promise<ImportReport> {
    const repo = parseGithubRepo(link)
    const wanted = opts.skills === undefined ? undefined : new Set(opts.skills)
    const report: ImportReport = { imported: [], skipped: [], notFound: [], invalid: [] }
    await mkdir(this.root, { recursive: true })
    // Staged next to the library so the final rename stays on one filesystem.
    const stage = await mkdtemp(join(dirname(this.root), '.skill-import-'))
    try {
      const checkout = join(stage, 'repo')
      await this.fetchRepo(repo, checkout)
      for (const dir of await findSkillDirs(checkout)) {
        const where = relative(checkout, dir).split(sep).join('/') || '.'
        let name: string
        try {
          name = parseSkillMeta(await readFile(join(dir, SKILL_FILE), 'utf8')).name
          assertSkillName(name)
        } catch (err) {
          report.invalid.push(`${where}: ${(err as Error).message}`)
          continue
        }
        if (report.imported.includes(name)) {
          report.invalid.push(`${where}: duplicate skill name "${name}"`)
          continue
        }
        if (wanted && !wanted.delete(name)) continue
        const target = join(this.root, name)
        if (await exists(target)) {
          if (!opts.overwrite) {
            report.skipped.push(name)
            continue
          }
          await rm(target, { recursive: true, force: true })
        }
        await rm(join(dir, '.git'), { recursive: true, force: true })
        await rename(dir, target)
        report.imported.push(name)
      }
      report.notFound.push(...wanted ?? [])
      return report
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }
}
