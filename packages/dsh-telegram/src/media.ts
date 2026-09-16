import { access, realpath } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'

const PHOTO_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/** Basename only, unsafe characters replaced, generated name when empty. */
export function sanitizeFilename(name: string | undefined, fallbackExt: string): string {
  const base = basename((name ?? '').replaceAll('\\', '/')).replace(/[^A-Za-z0-9._-]/g, '_')
  if (base === '' || base === '.' || base === '..') return `file-${Date.now()}${fallbackExt}`
  return base
}

/** Real path of `requested` inside `workspaceDir`; throws when missing or outside. */
export async function resolveInsideWorkspace(workspaceDir: string, requested: string): Promise<string> {
  const root = await realpath(workspaceDir)
  const target = await realpath(resolve(root, requested))
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`path is outside the chat workspace: ${requested}`)
  }
  return target
}

export function outboundKind(path: string): 'photo' | 'document' {
  return PHOTO_EXTENSIONS.has(extname(path).toLowerCase()) ? 'photo' : 'document'
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** `dir/filename`, or `dir/name-N.ext` for the first free N. */
export async function uniquePath(dir: string, filename: string): Promise<string> {
  const ext = extname(filename)
  const stem = filename.slice(0, filename.length - ext.length)
  let candidate = join(dir, filename)
  for (let n = 1; await exists(candidate); n++) candidate = join(dir, `${stem}-${n}${ext}`)
  return candidate
}
