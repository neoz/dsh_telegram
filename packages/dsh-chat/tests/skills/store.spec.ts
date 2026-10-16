import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseGithubRepo, parseSkillMeta, SkillStore, type GithubRepo, type RepoFetcher } from '../../src/skills/store.ts'

let dir: string
let root: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skills-'))
  root = join(dir, 'skills')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const md = (name: string, description = 'Does things') => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}\n`

async function tree(base: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(base, path)), { recursive: true })
    await writeFile(join(base, path), content)
  }
}

describe('parseSkillMeta', () => {
  it('reads name and description, unquoting values', () => {
    expect(parseSkillMeta('---\nname: "pdf"\ndescription: \'Read PDFs\'\n---\nx')).toEqual({ name: 'pdf', description: 'Read PDFs' })
  })

  it('rejects missing frontmatter or fields', () => {
    expect(() => parseSkillMeta('no frontmatter')).toThrow(/name field/)
    expect(() => parseSkillMeta('---\nname: pdf\n---\n')).toThrow(/description/)
  })
})

describe('parseGithubRepo', () => {
  it('accepts repository links with an optional ref', () => {
    expect(parseGithubRepo('github.com/anthropics/skills')).toEqual({ url: 'https://github.com/anthropics/skills.git' })
    expect(parseGithubRepo('https://github.com/o/r.git')).toEqual({ url: 'https://github.com/o/r.git' })
    expect(parseGithubRepo('https://github.com/o/r/tree/release/v2/')).toEqual({ url: 'https://github.com/o/r.git', ref: 'release/v2' })
  })

  it('rejects other links', () => {
    expect(() => parseGithubRepo('https://gitlab.com/o/r')).toThrow(/not a GitHub repository/)
    expect(() => parseGithubRepo('github.com/o')).toThrow(/not a GitHub repository/)
  })
})

describe('SkillStore.save / remove', () => {
  it('creates a skill, marks scripts executable, then updates it', async () => {
    const store = new SkillStore(root)
    expect(await store.save('pdf', [{ path: 'SKILL.md', content: md('pdf') }, { path: 'scripts/run.sh', content: 'echo hi' }]))
      .toBe('Created skill pdf: SKILL.md, scripts/run.sh')
    expect(await readFile(join(root, 'pdf', 'SKILL.md'), 'utf8')).toBe(md('pdf'))
    if (process.platform !== 'win32') expect((await stat(join(root, 'pdf', 'scripts', 'run.sh'))).mode & 0o111).not.toBe(0)
    expect(await store.save('pdf', [{ path: 'templates/a.txt', content: 'A' }])).toBe('Updated skill pdf: templates/a.txt')
  })

  it('rejects bad names, escaping paths, and incomplete or mismatched SKILL.md', async () => {
    const store = new SkillStore(root)
    await expect(store.save('Bad_Name', [{ path: 'SKILL.md', content: md('Bad_Name') }])).rejects.toThrow(/kebab-case/)
    await expect(store.save('pdf', [{ path: 'SKILL.md', content: md('pdf') }, { path: '../x', content: '' }])).rejects.toThrow(/inside the skill/)
    await expect(store.save('pdf', [{ path: '/etc/x', content: '' }])).rejects.toThrow(/inside the skill/)
    await expect(store.save('pdf', [{ path: 'notes.md', content: '' }])).rejects.toThrow(/include SKILL.md/)
    await expect(store.save('pdf', [{ path: 'SKILL.md', content: md('other') }])).rejects.toThrow(/must equal/)
    await expect(readdir(root)).rejects.toThrow()
  })

  it('deletes one file or the whole skill', async () => {
    const store = new SkillStore(root)
    await store.save('pdf', [{ path: 'SKILL.md', content: md('pdf') }, { path: 'a.txt', content: 'A' }])
    await expect(store.remove('pdf', 'SKILL.md')).rejects.toThrow(/whole skill/)
    await expect(store.remove('pdf', 'b.txt')).rejects.toThrow(/no file b.txt/)
    expect(await store.remove('pdf', 'a.txt')).toBe('Deleted a.txt from skill pdf')
    expect(await store.remove('pdf')).toBe('Deleted skill pdf')
    expect(await readdir(root)).toEqual([])
    await expect(store.remove('pdf')).rejects.toThrow(/no skill named/)
  })
})

describe('SkillStore.importRepo', () => {
  const fixture: Record<string, string> = {
    '.git/HEAD': 'ref',
    'README.md': 'repo',
    'skills/pdf/SKILL.md': md('pdf'),
    'skills/pdf/scripts/x.py': 'print(1)',
    'skills/pdf/nested/SKILL.md': md('nested'),
    'docs/SKILL.md': md('docs'),
    'broken/SKILL.md': 'no frontmatter',
  }
  let fetched: GithubRepo[]
  const fake: RepoFetcher = async (repo, dest) => {
    fetched.push(repo)
    await tree(dest, fixture)
  }
  beforeEach(() => { fetched = [] })

  it('imports every skill without descending into one, and reports invalid ones', async () => {
    const report = await new SkillStore(root, fake).importRepo('github.com/o/r/tree/main')
    expect(fetched).toEqual([{ url: 'https://github.com/o/r.git', ref: 'main' }])
    expect(report.imported.sort()).toEqual(['docs', 'pdf'])
    expect(report.invalid).toEqual(['broken: SKILL.md needs YAML frontmatter with a name field'])
    expect((await readdir(root)).sort()).toEqual(['docs', 'pdf'])
    expect(await readFile(join(root, 'pdf', 'scripts', 'x.py'), 'utf8')).toBe('print(1)')
    expect(await readdir(dir)).toEqual(['skills'])
  })

  it('imports only the named skills, keeps existing ones unless overwrite, and reports unknown names', async () => {
    const store = new SkillStore(root, fake)
    await store.save('pdf', [{ path: 'SKILL.md', content: md('pdf', 'local') }])
    const kept = await store.importRepo('github.com/o/r', { skills: ['pdf', 'nope'] })
    expect(kept).toEqual({ imported: [], skipped: ['pdf'], notFound: ['nope'], invalid: ['broken: SKILL.md needs YAML frontmatter with a name field'] })
    expect(await readdir(root)).toEqual(['pdf'])
    expect(parseSkillMeta(await readFile(join(root, 'pdf', 'SKILL.md'), 'utf8')).description).toBe('local')

    const replaced = await store.importRepo('github.com/o/r', { skills: ['pdf'], overwrite: true })
    expect(replaced.imported).toEqual(['pdf'])
    expect(parseSkillMeta(await readFile(join(root, 'pdf', 'SKILL.md'), 'utf8')).description).toBe('Does things')
  })

  it('cleans up the staging directory when the download fails', async () => {
    const store = new SkillStore(root, async () => { throw new Error('clone failed') })
    await expect(store.importRepo('github.com/o/r')).rejects.toThrow('clone failed')
    expect(await readdir(dir)).toEqual(['skills'])
  })
})
