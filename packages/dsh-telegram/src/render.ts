import type { StatusLabels } from './config.ts'

/** Telegram rendering rules ported from einoclaw's Go channel; all lengths are UTF-8 bytes. */

export const TELEGRAM_MAX_MESSAGE_BYTES = 4096
export const CAPTION_MAX_BYTES = 1024
export const SPLIT_THRESHOLD_RATIO = 1.2
export const UTF8_BOM = '\uFEFF'
export const CAPTION_SUFFIX = '\n\n<i>Please read the attached .md file.</i>'
export const UNDELIVERED_NOTICE = 'The reply was too long for one message, and sending it as a file failed too.'

const reHeading = /^#{1,6}\s+(.+)$/gm
const reBlockquote = /^>\s*(.*)$/gm
const reBold = /\*\*(.+?)\*\*/g
const reBoldUnderscore = /__([^<]+?)__/g
// Underscore italics only at word boundaries, so snake_case identifiers survive.
const reItalic = /(?<![\w])_([^_<>\n]+)_(?![\w])/g
const reStrike = /~~(.+?)~~/g
const reLink = /\[([^\]]+)\]\(([^)]+)\)/g
const reBullet = /^[-*]\s+/gm
const reCodeBlock = /```\w*\n?([\s\S]*?)```/g
const reInlineCode = /`([^`]+)`/g
const reOpenTag = /<(b|i|s|u|code|pre|a)\b[^>]*>/g
const reCloseTag = /<\/(b|i|s|u|code|pre|a)>/g

/** Placeholder marker; NUL never occurs in model output. */
const MARK = '\u0000'

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

export function escapeHTML(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function extract(text: string, re: RegExp, tag: string): { text: string; codes: string[] } {
  const codes: string[] = []
  const replaced = text.replace(re, (_match, code: string) => {
    codes.push(code)
    return `${MARK}${tag}${codes.length - 1}${MARK}`
  })
  return { text: replaced, codes }
}

export function markdownToTelegramHTML(markdown: string): string {
  if (markdown === '') return ''
  const blocks = extract(markdown, reCodeBlock, 'CB')
  const inline = extract(blocks.text, reInlineCode, 'IC')
  let text = inline.text
  text = text.replace(reHeading, '$1')
  text = text.replace(reBlockquote, '$1')
  text = escapeHTML(text)
  // Links go first and are parked as placeholders so inline markers inside link text or URLs
  // cannot open a tag that closes outside the anchor.
  const links: string[] = []
  text = text.replace(reLink, (_match, label: string, href: string) => {
    links.push(`<a href="${href}">${label}</a>`)
    return `${MARK}LK${links.length - 1}${MARK}`
  })
  text = text.replace(reBold, '<b>$1</b>')
  text = text.replace(reBoldUnderscore, '<b>$1</b>')
  text = text.replace(reItalic, '<i>$1</i>')
  text = text.replace(reStrike, '<s>$1</s>')
  text = text.replace(reBullet, '• ')
  links.forEach((link, i) => {
    text = text.replaceAll(`${MARK}LK${i}${MARK}`, link)
  })
  inline.codes.forEach((code, i) => {
    text = text.replaceAll(`${MARK}IC${i}${MARK}`, `<code>${escapeHTML(code)}</code>`)
  })
  blocks.codes.forEach((code, i) => {
    text = text.replaceAll(`${MARK}CB${i}${MARK}`, `<pre><code>${escapeHTML(code)}</code></pre>`)
  })
  return text
}

/** Close every tag left open, innermost first. */
export function repairHTMLTags(html: string): string {
  const stack: string[] = []
  const tokens = [...html.matchAll(reOpenTag)].map(m => ({ index: m.index, tag: m[1] as string, open: true }))
    .concat([...html.matchAll(reCloseTag)].map(m => ({ index: m.index, tag: m[1] as string, open: false })))
    .sort((a, b) => a.index - b.index)
  for (const token of tokens) {
    if (token.open) {
      stack.push(token.tag)
      continue
    }
    const at = stack.lastIndexOf(token.tag)
    if (at >= 0) stack.splice(at, 1)
  }
  return html + stack.reverse().map(tag => `</${tag}>`).join('')
}

/** String index whose UTF-8 prefix fits in `budgetBytes` without splitting a code point. */
function indexAtByteBudget(text: string, budgetBytes: number): number {
  let bytes = 0
  let index = 0
  for (const char of text) {
    const size = byteLength(char)
    if (bytes + size > budgetBytes) break
    bytes += size
    index += char.length
  }
  return index
}

/**
 * Split offset that never lands mid-character or mid-word: backs up from the
 * byte budget to the nearest paragraph, line, sentence (". ") or space break,
 * accepting only a break past the halfway mark.
 */
export function cleanCut(text: string, budgetBytes: number): number {
  if (byteLength(text) <= budgetBytes) return text.length
  const cut = indexAtByteBudget(text, budgetBytes)
  const head = text.slice(0, cut)
  const half = budgetBytes / 2
  const pastHalf = (index: number): boolean => index > 0 && byteLength(text.slice(0, index)) > half
  const paragraph = head.lastIndexOf('\n\n')
  if (pastHalf(paragraph)) return paragraph
  const line = head.lastIndexOf('\n')
  if (pastHalf(line)) return line
  const sentence = head.lastIndexOf('. ')
  if (pastHalf(sentence)) return sentence + 1
  const space = head.lastIndexOf(' ')
  if (pastHalf(space)) return space
  return cut
}

export function collapse(chunk: string): string {
  if (chunk.includes('<blockquote')) return `<tg-spoiler>${chunk}</tg-spoiler>`
  return `<blockquote expandable>${chunk}</blockquote>`
}

const COLLAPSE_WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ['<blockquote expandable>', '</blockquote>'],
  ['<tg-spoiler>', '</tg-spoiler>'],
]

export function stripCollapse(part: string): string {
  for (const [open, close] of COLLAPSE_WRAPPERS) {
    const i = part.indexOf(open)
    if (i >= 0 && part.endsWith(close)) {
      return part.slice(0, i) + part.slice(i + open.length, part.length - close.length)
    }
  }
  return part
}

/** One Telegram message: the first `openBytes` visible, the rest folded behind "Show more". */
export function renderMessage(html: string, openBytes: number): string {
  if (byteLength(html) <= openBytes * SPLIT_THRESHOLD_RATIO) return html
  const cut = cleanCut(html, openBytes)
  const head = repairHTMLTags(html.slice(0, cut).replace(/[ \n]+$/, ''))
  const tail = html.slice(cut).replace(/^\n+/, '')
  return `${head}\n${collapse(tail)}`
}

export function captionPrefix(html: string, maxBytes: number): string {
  if (byteLength(html) <= maxBytes) return html
  const cut = cleanCut(html, maxBytes - byteLength(CAPTION_SUFFIX))
  return repairHTMLTags(html.slice(0, cut).replace(/[ \n]+$/, '')) + CAPTION_SUFFIX
}

const TOOL_GROUPS: Record<string, keyof Omit<StatusLabels, 'thinking' | 'other'>> = {
  web_search: 'web',
  web_fetch: 'web',
  read: 'read',
  read_image: 'read',
  glob: 'read',
  grep: 'read',
  telegram_chat_history: 'read',
  write: 'write',
  edit: 'write',
  str_replace_editor: 'write',
  bash: 'command',
  pwsh: 'command',
  telegram_send_file: 'send',
}

/** Status label for a tool call; arguments are never shown to the chat. */
export function toolStatus(name: string, labels: StatusLabels): string {
  return labels[TOOL_GROUPS[name] ?? 'other']
}
