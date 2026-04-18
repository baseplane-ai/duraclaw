/**
 * Convert user-submitted content (plain string or structured ContentBlocks)
 * into SessionMessagePart shape so images survive persistence and render as
 * thumbnails instead of base64 blobs.
 */
import type { SessionMessagePart } from 'agents/experimental/memory/session'
import type { ContentBlock } from '~/lib/types'

/**
 * Custom part shape for user-attached images. We reuse SessionMessagePart's
 * loose `type: string` + `input: unknown` fields so we don't need to extend
 * the upstream interface. The `input` payload mirrors Anthropic's
 * ImageContentBlock source for easy round-tripping.
 */
export interface UserImagePart extends SessionMessagePart {
  type: 'image'
  input: {
    source: {
      type: 'base64'
      media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
      data: string
    }
  }
}

function isUserImagePart(part: SessionMessagePart): part is UserImagePart {
  return (
    part.type === 'image' &&
    typeof part.input === 'object' &&
    part.input !== null &&
    'source' in (part.input as Record<string, unknown>)
  )
}

/**
 * Build a display URL (data URL) for an image part, if it has a base64 source.
 * Returns null for parts that are not image parts or lack source data.
 */
export function getImagePartDataUrl(part: SessionMessagePart): string | null {
  if (!isUserImagePart(part)) return null
  const { source } = part.input
  return `data:${source.media_type};base64,${source.data}`
}

/**
 * Convert content (string or ContentBlock[]) into SessionMessageParts.
 * - `string` -> one text part
 * - `ContentBlock[]` -> image parts + one optional text part (order preserved)
 */
export function contentToParts(content: string | ContentBlock[]): SessionMessagePart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }

  const parts: SessionMessagePart[] = []
  for (const block of content) {
    if (block.type === 'image') {
      const imagePart: UserImagePart = {
        type: 'image',
        input: { source: block.source },
      }
      parts.push(imagePart)
    } else if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    }
  }
  return parts
}

/**
 * Convert user content pulled from the VPS SDK transcript into
 * SessionMessageParts. Handles the same shapes as `contentToParts` but is
 * defensive against unknown block types so transcript hydration never
 * silently drops data — unknown blocks fall back to a JSON-stringified
 * text part (the pre-fix behavior) rather than being dropped.
 *
 * The transcript delivers image blocks in Anthropic's wire shape
 * (`{type:'image', source:{type:'base64', media_type, data}}`), which this
 * helper converts into `UserImagePart` so the browser renderer's
 * `getImagePartDataUrl()` can build a displayable data URL on reload.
 */
export function transcriptUserContentToParts(content: unknown): SessionMessagePart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }

  if (!Array.isArray(content)) {
    return [{ type: 'text', text: JSON.stringify(content) }]
  }

  const parts: SessionMessagePart[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push({ type: 'text', text: block })
      continue
    }
    const b = block as Record<string, unknown>
    if (b?.type === 'text' && typeof b.text === 'string') {
      parts.push({ type: 'text', text: b.text })
      continue
    }
    if (b?.type === 'image' && b.source && typeof b.source === 'object') {
      const src = b.source as Record<string, unknown>
      if (
        src.type === 'base64' &&
        typeof src.media_type === 'string' &&
        typeof src.data === 'string'
      ) {
        const imagePart: UserImagePart = {
          type: 'image',
          input: {
            source: {
              type: 'base64',
              media_type: src.media_type as UserImagePart['input']['source']['media_type'],
              data: src.data,
            },
          },
        }
        parts.push(imagePart)
        continue
      }
    }
    // Unknown block shape — preserve pre-fix fallback so nothing is lost.
    parts.push({ type: 'text', text: JSON.stringify(block) })
  }
  return parts
}
