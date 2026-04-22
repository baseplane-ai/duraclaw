import { describe, expect, it } from 'vitest'
import { promptToPreviewText } from './prompt-preview'

describe('promptToPreviewText', () => {
  it('returns string prompts unchanged', () => {
    expect(promptToPreviewText('hello world')).toBe('hello world')
  })

  it('returns empty string for null / undefined', () => {
    expect(promptToPreviewText(null)).toBe('')
    expect(promptToPreviewText(undefined)).toBe('')
  })

  it('extracts text from a text-only ContentBlock[]', () => {
    expect(promptToPreviewText([{ type: 'text', text: 'refactor the foo' }])).toBe(
      'refactor the foo',
    )
  })

  it('concatenates multiple text blocks', () => {
    expect(
      promptToPreviewText([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first second')
  })

  it('returns [image] marker when only an image block is present', () => {
    expect(
      promptToPreviewText([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
        },
      ]),
    ).toBe('[image]')
  })

  it('pluralises the image marker when multiple images and no text', () => {
    expect(
      promptToPreviewText([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
        },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' },
        },
      ]),
    ).toBe('[2 images]')
  })

  it('keeps text and appends an image marker when both are present', () => {
    expect(
      promptToPreviewText([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
        },
        { type: 'text', text: 'whats in this screenshot?' },
      ]),
    ).toBe('whats in this screenshot? [image]')
  })

  it('ignores empty text blocks', () => {
    expect(
      promptToPreviewText([
        { type: 'text', text: '   ' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
        },
      ]),
    ).toBe('[image]')
  })

  it('returns empty string for an empty array', () => {
    expect(promptToPreviewText([])).toBe('')
  })

  it('ignores malformed blocks', () => {
    expect(
      promptToPreviewText([
        // biome-ignore lint/suspicious/noExplicitAny: testing runtime robustness against bad input
        null as any,
        // biome-ignore lint/suspicious/noExplicitAny: testing runtime robustness against bad input
        { type: 'text' } as any,
        { type: 'text', text: 'ok' },
      ]),
    ).toBe('ok')
  })
})
