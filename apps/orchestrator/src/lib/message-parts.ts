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
  /** When true, `source.data` was stripped before SQLite persistence because
   *  the R2 bucket was unavailable and the row would have exceeded the DO
   *  SQLite row-size cap. UI should show a placeholder. */
  truncated?: boolean
  input: {
    source: {
      type: 'base64'
      media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
      data: string
      /** R2 object key. When present, image bytes live in the SESSION_MEDIA
       *  bucket and `data` is empty. The UI fetches via
       *  `GET /api/sessions/media/<r2Key>`. */
      r2Key?: string
    }
  }
}

/**
 * CF DO SQLite caps TEXT/BLOB at ~2 MB per row. We use 1 MiB as a safe
 * threshold — well under the limit to leave room for envelope + other columns.
 */
export const MAX_PARTS_JSON_BYTES = 1024 * 1024 // 1 MiB

function isUserImagePart(part: SessionMessagePart): part is UserImagePart {
  return (
    part.type === 'image' &&
    typeof part.input === 'object' &&
    part.input !== null &&
    'source' in (part.input as Record<string, unknown>)
  )
}

/**
 * Build a display URL for an image part. Returns:
 * - An API URL (`/api/sessions/media/<r2Key>`) when the image is R2-backed
 * - A data URL (`data:<mime>;base64,<data>`) when the image is inline
 * - `null` for non-image parts or truncated images with no R2 fallback
 */
export function getImagePartDataUrl(part: SessionMessagePart): string | null {
  if (!isUserImagePart(part)) return null
  const { source } = part.input
  if (source.r2Key) return `/api/sessions/media/${source.r2Key}`
  if (!source.data) return null
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

/**
 * Returns true when the part is a UserImagePart whose base64 data was
 * stripped before SQLite storage (R2 unavailable fallback).
 * UI consumers should show a placeholder.
 */
export function isImageTruncated(part: SessionMessagePart): boolean {
  return isUserImagePart(part) && part.truncated === true
}

/** Media type → file extension for R2 keys. */
const MEDIA_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/**
 * Offload oversized base64 image data to R2 before SQLite persistence.
 *
 * When the total serialized size of `parts` exceeds `MAX_PARTS_JSON_BYTES`:
 * 1. If `r2Bucket` is available, uploads each image to R2 under
 *    `session-media/<sessionId>/<messageId>/<index>.<ext>`, clears `data`,
 *    and sets `r2Key` so the UI can fetch via `/api/sessions/media/<r2Key>`.
 * 2. If `r2Bucket` is unavailable (local dev), falls back to truncation:
 *    clears `data` and sets `truncated: true`.
 *
 * No-op when parts are already under the threshold. Mutates in place.
 */
export async function offloadOversizedImages(
  parts: SessionMessagePart[],
  context: {
    sessionId: string
    messageId: string
    r2Bucket?: R2Bucket | null
  },
): Promise<void> {
  const serialized = JSON.stringify(parts)
  if (serialized.length <= MAX_PARTS_JSON_BYTES) return

  const bucket = context.r2Bucket
  let offloaded = 0

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!isUserImagePart(part) || part.input.source.data.length === 0) continue

    if (bucket) {
      const ext = MEDIA_EXT[part.input.source.media_type] ?? 'bin'
      const r2Key = `session-media/${context.sessionId}/${context.messageId}/${i}.${ext}`
      try {
        const bytes = Uint8Array.from(atob(part.input.source.data), (c) => c.charCodeAt(0))
        await bucket.put(r2Key, bytes, {
          httpMetadata: { contentType: part.input.source.media_type },
        })
        part.input.source.r2Key = r2Key
        part.input.source.data = ''
        offloaded++
      } catch (err) {
        // R2 write failed — fall back to truncation for this part
        console.error('[offload-images] R2 put failed, truncating instead', {
          sessionId: context.sessionId,
          messageId: context.messageId,
          partIndex: i,
          error: String(err),
        })
        part.input.source.data = ''
        part.truncated = true
      }
    } else {
      // No R2 bucket — truncation fallback
      part.input.source.data = ''
      part.truncated = true
    }
  }

  const action = offloaded > 0 ? `offloaded ${offloaded} to R2` : 'truncated (no R2)'
  console.warn(`[offload-images] ${action}`, {
    sessionId: context.sessionId,
    messageId: context.messageId,
    originalBytes: serialized.length,
    sanitizedBytes: JSON.stringify(parts).length,
  })
}

/**
 * Synchronous truncation-only fallback for `safeUpdateMessage` (which must
 * stay sync to match the SDK's `updateMessage(): void` contract). Images
 * should already be offloaded by `safeAppendMessage`; this is a safety net.
 */
export function sanitizePartsForStorage(
  parts: SessionMessagePart[],
  context?: { sessionId?: string; messageId?: string },
): SessionMessagePart[] {
  const serialized = JSON.stringify(parts)
  if (serialized.length <= MAX_PARTS_JSON_BYTES) return parts

  let stripped = false
  for (const part of parts) {
    if (isUserImagePart(part) && part.input.source.data.length > 0) {
      part.input.source.data = ''
      part.truncated = true
      stripped = true
    }
  }

  if (stripped) {
    console.warn('[sanitize-parts] Stripped oversized base64 image data before SQLite write', {
      sessionId: context?.sessionId ?? 'unknown',
      messageId: context?.messageId ?? 'unknown',
      originalBytes: serialized.length,
      sanitizedBytes: JSON.stringify(parts).length,
    })
  }

  return parts
}
