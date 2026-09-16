import { describe, expect, it } from 'vitest'
import {
  CAPTION_SUFFIX,
  byteLength,
  captionPrefix,
  cleanCut,
  collapse,
  escapeHTML,
  markdownToTelegramHTML,
  renderMessage,
  repairHTMLTags,
  stripCollapse,
  summarizeToolCall,
} from '../src/render.ts'

describe('escapeHTML', () => {
  it.each([
    ['no special chars', 'no special chars'],
    ['a & b', 'a &amp; b'],
    ['a < b', 'a &lt; b'],
    ['<a>&b</a>', '&lt;a&gt;&amp;b&lt;/a&gt;'],
    ['', ''],
  ])('%j', (input, want) => {
    expect(escapeHTML(input)).toBe(want)
  })
})

describe('markdownToTelegramHTML', () => {
  it.each([
    ['', ''],
    ['hello world', 'hello world'],
    ['**bold text**', '<b>bold text</b>'],
    ['some _italic_ text', 'some <i>italic</i> text'],
    ['~~strike~~', '<s>strike</s>'],
    ['use `fmt.Println`', 'use <code>fmt.Println</code>'],
    ['[Go](https://go.dev)', '<a href="https://go.dev">Go</a>'],
    ['```go\nfmt.Println("hello")\n```', '<pre><code>fmt.Println("hello")\n</code></pre>'],
    ['a < b & c > d', 'a &lt; b &amp; c &gt; d'],
    ["```\n<script>alert('xss')</script>\n```", "<pre><code>&lt;script&gt;alert('xss')&lt;/script&gt;\n</code></pre>"],
    ['- item one\n- item two', '• item one\n• item two'],
    ['* item one\n* item two', '• item one\n• item two'],
    ['## Section Title', 'Section Title'],
    ['__bold text__', '<b>bold text</b>'],
    ['> quoted', 'quoted'],
  ])('%j', (input, want) => {
    expect(markdownToTelegramHTML(input)).toBe(want)
  })

  it('escapes inline code content', () => {
    expect(markdownToTelegramHTML('run `echo <hello>`')).toContain('<code>echo &lt;hello&gt;</code>')
  })
})

describe('repairHTMLTags', () => {
  it.each([
    ['plain text', 'plain text'],
    ['<b>bold</b>', '<b>bold</b>'],
    ['<b>bold', '<b>bold</b>'],
    ['<b>bold <i>italic', '<b>bold <i>italic</i></b>'],
    ['<pre><code>fn()', '<pre><code>fn()</code></pre>'],
    ['<b>ok</b> <i>ok</i>', '<b>ok</b> <i>ok</i>'],
  ])('%j', (input, want) => {
    expect(repairHTMLTags(input)).toBe(want)
  })
})

describe('cleanCut', () => {
  it('returns the full length when under budget', () => {
    expect(cleanCut('short', 100)).toBe(5)
  })
  it('prefers a paragraph break past the halfway mark', () => {
    const text = 'a'.repeat(600) + '\n\n' + 'b'.repeat(600)
    expect(cleanCut(text, 1000)).toBe(600)
  })
  it('never splits a multi-byte character', () => {
    const text = 'ắ'.repeat(700) // 3 bytes each, no spaces
    const cut = cleanCut(text, 1000)
    expect(byteLength(text.slice(0, cut))).toBeLessThanOrEqual(1000)
    expect(text.slice(0, cut)).toBe('ắ'.repeat(cut))
  })
  it('does not treat a version number as a sentence end', () => {
    const text = 'x'.repeat(590) + ' v6.2.0.0 ' + 'y'.repeat(600)
    const cut = cleanCut(text, 1000)
    expect(text.slice(cut, cut + 1)).toBe(' ')
  })
})

describe('renderMessage', () => {
  it('returns content below the threshold untouched', () => {
    const html = 'a'.repeat(1100)
    expect(renderMessage(html, 1000)).toBe(html)
  })
  it('opens the head and collapses the tail', () => {
    const head = 'alpha beta gamma delta '.repeat(44)
    const tail = 'tail content here '.repeat(100)
    const got = renderMessage(head + '\n\n' + tail, 1024)
    expect(got).toContain('<blockquote expandable>')
    expect(got.startsWith(head.slice(0, 200))).toBe(true)
  })
  it('preserves all content', () => {
    const html = 'mot dong van ban\n'.repeat(200)
    const got = renderMessage(html, 1024).replaceAll('<blockquote expandable>', '').replaceAll('</blockquote>', '')
    expect(byteLength(got)).toBeGreaterThanOrEqual(byteLength(html))
  })
  it('head never ends mid-word', () => {
    const html = 'Day la mot cau tieng Viet khong dau de kiem tra. '.repeat(100)
    const got = renderMessage(html, 1024)
    const idx = got.indexOf('<blockquote expandable>')
    const head = got.slice(0, idx).replace(/[ \n]+$/, '')
    const next = html.slice(head.length, head.length + 1)
    expect([' ', '\n', '.', '']).toContain(next)
  })
  it('uses a spoiler when the tail already has a blockquote', () => {
    const html = '<blockquote>quoted line</blockquote>\n'.repeat(100)
    const got = renderMessage(html, 1024)
    expect(got).toContain('<tg-spoiler>')
    expect(got).not.toContain('<blockquote expandable>')
  })
})

describe('collapse / stripCollapse', () => {
  it('wraps in an expandable blockquote', () => {
    expect(collapse('body')).toBe('<blockquote expandable>body</blockquote>')
  })
  it.each([
    ['<b>head</b>\n<blockquote expandable>body</blockquote>', '<b>head</b>\nbody'],
    ['<b>head</b>\n<tg-spoiler>body</tg-spoiler>', '<b>head</b>\nbody'],
    ['<b>head</b>\nbody', '<b>head</b>\nbody'],
    ['<tg-spoiler><blockquote>inner</blockquote></tg-spoiler>', '<blockquote>inner</blockquote>'],
  ])('strips %j', (input, want) => {
    expect(stripCollapse(input)).toBe(want)
  })
})

describe('captionPrefix', () => {
  it('returns short html unchanged', () => {
    expect(captionPrefix('<b>hi</b>', 1024)).toBe('<b>hi</b>')
  })
  it('bounds the result by bytes and ends with the notice', () => {
    const html = 'word '.repeat(500)
    const got = captionPrefix(html, 1024)
    expect(byteLength(got)).toBeLessThanOrEqual(1024)
    expect(got.endsWith(CAPTION_SUFFIX)).toBe(true)
  })
  it('closes tags cut in half', () => {
    const html = '<b>' + 'word '.repeat(500) + '</b>'
    const body = captionPrefix(html, 1024).slice(0, -CAPTION_SUFFIX.length)
    expect(body.endsWith('</b>')).toBe(true)
  })
})

describe('summarizeToolCall', () => {
  it('shows the first string argument on one line', () => {
    expect(summarizeToolCall('bash', '{"command":"ls -la\n/tmp"}', 60)).toBe('bash: ls -la /tmp')
  })
  it('falls back to the tool name on bad json', () => {
    expect(summarizeToolCall('read', '{oops', 60)).toBe('read')
  })
  it('truncates to maxChars', () => {
    const got = summarizeToolCall('bash', JSON.stringify({ command: 'x'.repeat(200) }), 20)
    expect(got.length).toBeLessThanOrEqual(20)
  })
})
