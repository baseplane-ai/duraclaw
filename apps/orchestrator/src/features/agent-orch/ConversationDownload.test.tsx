/**
 * @vitest-environment jsdom
 *
 * ConversationDownload tests — verifies markdown generation and download behavior.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionMessage } from '~/lib/types'
import { ConversationDownload } from './ConversationDownload'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/**
 * Helper to mock the download mechanism. Intercepts only 'a' element creation
 * so React's own createElement calls are not affected.
 */
function mockDownload() {
  const mockUrl = 'blob:test-url'
  const createObjectURL = vi.fn(() => mockUrl)
  const revokeObjectURL = vi.fn()
  globalThis.URL.createObjectURL = createObjectURL
  globalThis.URL.revokeObjectURL = revokeObjectURL

  const clickFn = vi.fn()
  const mockAnchor = { href: '', download: '', click: clickFn }
  const origCreateElement = document.createElement.bind(document)

  vi.spyOn(document, 'createElement').mockImplementation(
    (tag: string, options?: ElementCreationOptions) => {
      if (tag === 'a') return mockAnchor as unknown as HTMLAnchorElement
      return origCreateElement(tag, options)
    },
  )

  return { createObjectURL, revokeObjectURL, clickFn, mockAnchor }
}

describe('ConversationDownload', () => {
  it('returns null when messages array is empty', () => {
    const { container } = render(<ConversationDownload messages={[]} sessionId="sess-1" />)
    expect(container.innerHTML).toBe('')
  })

  it('renders a download button when messages exist', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
        createdAt: new Date(),
      },
    ]

    render(<ConversationDownload messages={messages} sessionId="sess-1" />)

    const button = screen.getByLabelText('Download conversation')
    expect(button).toBeTruthy()
    expect(button.getAttribute('title')).toBe('Download as Markdown')
  })

  it('creates a blob download on click', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello world' }],
        createdAt: new Date(),
      },
      {
        id: 'msg-2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hi there' }],
        createdAt: new Date(),
      },
    ]

    const { createObjectURL, revokeObjectURL, clickFn, mockAnchor } = mockDownload()

    render(<ConversationDownload messages={messages} sessionId="sess-42" />)
    fireEvent.click(screen.getByLabelText('Download conversation'))

    expect(createObjectURL).toHaveBeenCalledOnce()
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('text/markdown')

    expect(mockAnchor.href).toBe('blob:test-url')
    expect(mockAnchor.download).toMatch(/^session-sess-42-\d{4}-\d{2}-\d{2}\.md$/)
    expect(clickFn).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-url')
  })

  it('generates markdown with user and assistant sections', async () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'What is 2+2?' }],
        createdAt: new Date(),
      },
      {
        id: 'msg-2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'The answer is 4.' }],
        createdAt: new Date(),
      },
    ]

    const { createObjectURL } = mockDownload()

    render(<ConversationDownload messages={messages} sessionId="s1" />)
    fireEvent.click(screen.getByLabelText('Download conversation'))

    const blob = createObjectURL.mock.calls[0][0] as Blob
    const text = await blob.text()
    expect(text).toContain('## User')
    expect(text).toContain('What is 2+2?')
    expect(text).toContain('## Assistant')
    expect(text).toContain('The answer is 4.')
  })

  it('generates markdown with reasoning sections', async () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'reasoning', text: 'Let me think...' }],
        createdAt: new Date(),
      },
    ]

    const { createObjectURL } = mockDownload()

    render(<ConversationDownload messages={messages} sessionId="s1" />)
    fireEvent.click(screen.getByLabelText('Download conversation'))

    const blob = createObjectURL.mock.calls[0][0] as Blob
    const text = await blob.text()
    expect(text).toContain('<details><summary>Reasoning</summary>')
    expect(text).toContain('Let me think...')
    expect(text).toContain('</details>')
  })

  it('generates markdown with tool sections', async () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-read_file',
            toolName: 'read_file',
            input: { path: '/tmp/test.txt' },
            output: 'file contents here',
            state: 'output-available',
          },
        ],
        createdAt: new Date(),
      },
    ]

    const { createObjectURL } = mockDownload()

    render(<ConversationDownload messages={messages} sessionId="s1" />)
    fireEvent.click(screen.getByLabelText('Download conversation'))

    const blob = createObjectURL.mock.calls[0][0] as Blob
    const text = await blob.text()
    expect(text).toContain('```tool: read_file')
    expect(text).toContain('/tmp/test.txt')
    expect(text).toContain('--- output ---')
    expect(text).toContain('file contents here')
  })
})
