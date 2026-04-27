import './jsdom-bootstrap.js'

import { DOCS_YDOC_FRAGMENT_NAME } from '@duraclaw/shared-types'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { markdownToYDoc, normalisedMarkdown, yDocToMarkdown } from './blocknote-bridge.js'

async function roundTrip(md: string): Promise<string> {
  const ydoc = new Y.Doc()
  await markdownToYDoc(md, ydoc)
  return yDocToMarkdown(ydoc)
}

async function expectSemanticallyEqual(input: string): Promise<void> {
  const out = await roundTrip(input)
  const normalisedInput = await normalisedMarkdown(input)
  expect(out.trim()).toBe(normalisedInput.trim())
}

describe('blocknote-bridge — markdown ↔ Y.Doc round-trip', () => {
  it('round-trips an h1 heading', async () => {
    await expectSemanticallyEqual('# Heading One\n')
  })

  it('round-trips an h2 heading', async () => {
    await expectSemanticallyEqual('## Heading Two\n')
  })

  it('round-trips an h3 heading', async () => {
    await expectSemanticallyEqual('### Heading Three\n')
  })

  it('round-trips a paragraph with inline marks (bold/italic/code/link)', async () => {
    const input =
      'Some **bold** text with *italic* and `inline code` plus a [link](https://example.com).\n'
    await expectSemanticallyEqual(input)
  })

  it('round-trips an unordered list with a nested item', async () => {
    const input = ['- top item', '  - nested item', '- second top', ''].join('\n')
    await expectSemanticallyEqual(input)
  })

  it('round-trips an ordered list', async () => {
    const input = ['1. first', '2. second', '3. third', ''].join('\n')
    await expectSemanticallyEqual(input)
  })

  it('round-trips a blockquote with embedded bold', async () => {
    const input = '> a quote with **bold** inside\n'
    await expectSemanticallyEqual(input)
  })

  it('round-trips a fenced code block with language tag', async () => {
    const input = ['```ts', 'const x: number = 42', 'console.log(x)', '```', ''].join('\n')
    await expectSemanticallyEqual(input)
  })

  it('round-trips a 2x2 GFM table with header row', async () => {
    const input = ['| h1 | h2 |', '| --- | --- |', '| a | b |', '| c | d |', ''].join('\n')
    await expectSemanticallyEqual(input)
  })

  it('two markdownToYDoc calls accumulate — second call wins', async () => {
    const ydoc = new Y.Doc()
    await markdownToYDoc('# First\n', ydoc)
    await markdownToYDoc('# Second\n', ydoc)
    const out = await yDocToMarkdown(ydoc)
    expect(out).toContain('Second')
  })

  it('uses DOCS_YDOC_FRAGMENT_NAME as the fragment key', async () => {
    expect(DOCS_YDOC_FRAGMENT_NAME).toBe('document-store')
    const ydoc = new Y.Doc()
    await markdownToYDoc('# Hello\n', ydoc)
    const fragment = ydoc.getXmlFragment(DOCS_YDOC_FRAGMENT_NAME)
    expect(fragment.length).toBeGreaterThan(0)
  })
})
