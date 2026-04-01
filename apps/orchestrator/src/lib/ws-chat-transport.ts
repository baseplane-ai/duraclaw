import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'

// Browser WebSocket interface (CF Workers types override the global WebSocket)
interface BrowserWebSocket {
  readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  send(data: string): void
  close(): void
}

/** Chunk types that are custom extensions, not standard UIMessageChunk */
const CUSTOM_CHUNK_TYPES = new Set(['history', 'turn-complete', 'file-changed'])

/**
 * WebSocket-based ChatTransport for the AI SDK.
 *
 * Each sendMessages() call establishes a WS connection to SessionDO,
 * sends the new user message, and returns a ReadableStream of UIMessageChunk.
 * Custom extension chunks (history, turn-complete) are filtered out.
 *
 * The stream stays open for the entire turn, including tool approval waits.
 */
export class WsChatTransport implements ChatTransport<UIMessage> {
  private sessionId: string

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  async sendMessages(options: {
    trigger: 'submit-message' | 'regenerate-message'
    chatId: string
    messageId: string | undefined
    messages: UIMessage[]
    abortSignal: AbortSignal | undefined
  }): Promise<ReadableStream<UIMessageChunk>> {
    // Only send the latest user message — server has the history
    const lastMessage = options.messages[options.messages.length - 1]
    const content = lastMessage.parts
      .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('')

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        // @ts-expect-error — browser-only: window.location and WebSocket
        const loc = window.location
        const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:'
        const url = `${protocol}//${loc.host}/api/sessions/${this.sessionId}/ws`
        // @ts-expect-error — browser-only: native WebSocket constructor
        const ws = new WebSocket(url) as BrowserWebSocket

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'user-message', content }))
        }

        ws.onmessage = (event) => {
          try {
            const chunk = JSON.parse(event.data as string) as Record<string, unknown>

            // Filter custom extension chunks that aren't in the AI SDK protocol
            if (CUSTOM_CHUNK_TYPES.has(chunk.type as string)) return

            controller.enqueue(chunk as unknown as UIMessageChunk)

            if (chunk.type === 'finish') {
              try { controller.close() } catch {}
            }
          } catch {
            // Ignore parse errors
          }
        }

        ws.onclose = () => {
          try { controller.close() } catch {}
        }

        ws.onerror = () => {
          try { controller.error(new Error('WebSocket connection error')) } catch {}
        }

        options.abortSignal?.addEventListener('abort', () => {
          ws.close()
        })
      },
    })
  }

  async reconnectToStream(
    _options: { chatId: string },
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    // Connect WS and listen for ongoing turn chunks.
    // Returns null-like empty stream if no active turn — useChat handles this gracefully.
    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        // @ts-expect-error — browser-only
        const loc = window.location
        const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:'
        const url = `${protocol}//${loc.host}/api/sessions/${this.sessionId}/ws`
        // @ts-expect-error — browser-only
        const ws = new WebSocket(url) as BrowserWebSocket

        ws.onmessage = (event) => {
          try {
            const chunk = JSON.parse(event.data as string) as Record<string, unknown>
            if (CUSTOM_CHUNK_TYPES.has(chunk.type as string)) return

            controller.enqueue(chunk as unknown as UIMessageChunk)

            if (chunk.type === 'finish') {
              try { controller.close() } catch {}
            }
          } catch {}
        }

        ws.onclose = () => {
          try { controller.close() } catch {}
        }

        ws.onerror = () => {
          try { controller.close() } catch {}
        }
      },
    })
  }
}
