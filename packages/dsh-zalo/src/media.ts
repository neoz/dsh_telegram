/** Image types `dsh-attachment` accepts. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Media type from the file signature; undefined when the bytes are not a supported image. */
export function sniffImageType(data: Buffer): ImageMediaType | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (data.length >= 4 && data.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
  return undefined
}

const EXTENSIONS: Record<ImageMediaType, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }

export function extensionFor(type: ImageMediaType): string {
  return EXTENSIONS[type]
}
