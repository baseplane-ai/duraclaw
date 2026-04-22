import { describe, expect, it } from 'vitest'
import {
  contentToParts,
  getImagePartDataUrl,
  isImageTruncated,
  MAX_PARTS_JSON_BYTES,
  sanitizePartsForStorage,
  transcriptUserContentToParts,
} from './message-parts'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('contentToParts', () => {
  it('converts plain string to one text part', () => {
    expect(contentToParts('hello')).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('converts mixed image + text blocks to image + text parts', () => {
    const parts = contentToParts([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
      { type: 'text', text: 'caption' },
    ])
    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatchObject({ type: 'image' })
    expect(parts[1]).toEqual({ type: 'text', text: 'caption' })
  })
})

describe('transcriptUserContentToParts', () => {
  it('converts a plain-string transcript content to one text part', () => {
    expect(transcriptUserContentToParts('hello')).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('converts an image + text array to proper image and text parts', () => {
    const parts = transcriptUserContentToParts([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 },
      },
      { type: 'text', text: 'look at this' },
    ])

    expect(parts).toHaveLength(2)

    const [imagePart, textPart] = parts

    expect(imagePart.type).toBe('image')
    // The image part must round-trip its base64 data so the renderer can
    // rebuild the data: URL without ever stringifying the blob into text.
    expect((imagePart as { input: { source: { data: string } } }).input.source.data).toBe(
      PNG_BASE64,
    )
    expect(getImagePartDataUrl(imagePart)).toBe(`data:image/png;base64,${PNG_BASE64}`)

    expect(textPart).toEqual({ type: 'text', text: 'look at this' })
  })

  it('falls back to JSON-stringified text part for unknown block types', () => {
    const mystery = { type: 'server_tool_use', name: 'web_search' }
    const parts = transcriptUserContentToParts([mystery])
    expect(parts).toEqual([{ type: 'text', text: JSON.stringify(mystery) }])
  })

  it('returns one text part with JSON.stringify for non-string non-array content', () => {
    const weird = { foo: 'bar' }
    expect(transcriptUserContentToParts(weird)).toEqual([
      { type: 'text', text: JSON.stringify(weird) },
    ])
  })

  it('does not embed base64 data into a text part (regression for image-hydration bug)', () => {
    const parts = transcriptUserContentToParts([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 },
      },
    ])
    expect(parts).toHaveLength(1)
    expect(parts[0].type).toBe('image')
    // The base64 blob must not leak into any text part on any part.
    for (const p of parts) {
      if (p.type === 'text') {
        expect((p as { text: string }).text).not.toContain(PNG_BASE64)
      }
    }
  })
})

// ── GH#65: sanitizePartsForStorage ──────────────────────────────────

describe('sanitizePartsForStorage', () => {
  /** Generate a fake base64 string of approximately `bytes` length. */
  function fakeBase64(bytes: number): string {
    return 'A'.repeat(bytes)
  }

  function makeImagePart(dataBytes: number) {
    return {
      type: 'image' as const,
      input: {
        source: {
          type: 'base64' as const,
          media_type: 'image/png' as const,
          data: fakeBase64(dataBytes),
        },
      },
    }
  }

  it('is a no-op when parts are under the threshold', () => {
    const parts = [{ type: 'text', text: 'hello' }]
    const result = sanitizePartsForStorage(parts)
    expect(result).toBe(parts) // same reference
    expect(result[0]).toEqual({ type: 'text', text: 'hello' })
  })

  it('is a no-op for small images under threshold', () => {
    const parts = [makeImagePart(1000), { type: 'text', text: 'caption' }]
    const result = sanitizePartsForStorage(parts)
    expect(result[0]).toMatchObject({ type: 'image' })
    expect((result[0] as any).input.source.data.length).toBe(1000)
    expect((result[0] as any).truncated).toBeUndefined()
  })

  it('strips base64 data and sets truncated flag when over threshold', () => {
    // Create an image large enough to exceed MAX_PARTS_JSON_BYTES
    const parts = [makeImagePart(MAX_PARTS_JSON_BYTES + 1000), { type: 'text', text: 'caption' }]
    const result = sanitizePartsForStorage(parts)

    const imgPart = result[0] as any
    expect(imgPart.type).toBe('image')
    expect(imgPart.truncated).toBe(true)
    expect(imgPart.input.source.data).toBe('')

    // Text part is untouched
    expect(result[1]).toEqual({ type: 'text', text: 'caption' })
  })

  it('strips all image parts when multiple images push over threshold', () => {
    // Two images that together exceed threshold
    const halfSize = Math.floor(MAX_PARTS_JSON_BYTES / 2) + 1000
    const parts = [makeImagePart(halfSize), makeImagePart(halfSize)]
    const result = sanitizePartsForStorage(parts)

    for (const part of result) {
      const p = part as any
      expect(p.truncated).toBe(true)
      expect(p.input.source.data).toBe('')
    }
  })

  it('sanitized result fits under threshold', () => {
    const parts = [makeImagePart(MAX_PARTS_JSON_BYTES + 5000)]
    sanitizePartsForStorage(parts)
    expect(JSON.stringify(parts).length).toBeLessThan(MAX_PARTS_JSON_BYTES)
  })

  it('does not touch text-only parts even if very large', () => {
    // A giant text part — should NOT be truncated (only images are stripped)
    const bigText = 'x'.repeat(MAX_PARTS_JSON_BYTES + 1000)
    const parts = [{ type: 'text', text: bigText }]
    const result = sanitizePartsForStorage(parts)
    expect(result[0]).toEqual({ type: 'text', text: bigText })
  })
})

describe('isImageTruncated', () => {
  it('returns true for a truncated image part', () => {
    const part = {
      type: 'image' as const,
      truncated: true,
      input: {
        source: { type: 'base64' as const, media_type: 'image/png' as const, data: '' },
      },
    }
    expect(isImageTruncated(part)).toBe(true)
  })

  it('returns false for a normal image part', () => {
    const part = {
      type: 'image' as const,
      input: {
        source: { type: 'base64' as const, media_type: 'image/png' as const, data: PNG_BASE64 },
      },
    }
    expect(isImageTruncated(part)).toBe(false)
  })

  it('returns false for a text part', () => {
    expect(isImageTruncated({ type: 'text', text: 'hello' })).toBe(false)
  })
})
