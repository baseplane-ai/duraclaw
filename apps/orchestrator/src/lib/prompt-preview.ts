/**
 * prompt-preview — Reduce a `string | ContentBlock[]` prompt to a short
 * human-readable string suitable for persisting to `agent_sessions.prompt`
 * and rendering as a session title / preview.
 *
 * Context: when a user starts a session with an image paste, `prompt` comes
 * across as a `ContentBlock[]` containing one or more `{type:'image'}` blocks
 * plus optionally a trailing `{type:'text'}` block. Naively
 * `JSON.stringify(prompt)` leaks a huge base64 blob into the UI as the
 * session's displayed "title" (fallback chain:
 * `session.title || session.summary || session.prompt || id.slice(0,8)`).
 *
 * Rules:
 *   - `string`          -> returned as-is
 *   - `ContentBlock[]`  -> concatenate `text` blocks (whitespace-joined,
 *                         trimmed). If there are no text blocks but at
 *                         least one image block, return an `[image]` /
 *                         `[N images]` marker so the row still has a
 *                         meaningful preview.
 *   - empty / unknown   -> empty string (caller decides fallback)
 */

import type { ContentBlock } from '@duraclaw/shared-types'

export function promptToPreviewText(prompt: string | ContentBlock[] | null | undefined): string {
  if (prompt == null) return ''
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return ''

  const textParts: string[] = []
  let imageCount = 0
  for (const block of prompt) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const t = block.text.trim()
      if (t) textParts.push(t)
    } else if (block.type === 'image') {
      imageCount++
    }
  }

  const joined = textParts.join(' ').trim()
  if (joined) {
    return imageCount > 0
      ? `${joined} ${imageCount === 1 ? '[image]' : `[${imageCount} images]`}`
      : joined
  }
  if (imageCount > 0) {
    return imageCount === 1 ? '[image]' : `[${imageCount} images]`
  }
  return ''
}
