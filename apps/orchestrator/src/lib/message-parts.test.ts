import { describe, expect, it } from 'vitest'
import { contentToParts, getImagePartDataUrl, transcriptUserContentToParts } from './message-parts'

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
