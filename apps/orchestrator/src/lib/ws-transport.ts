import type { BrowserCommand, UIStreamChunk } from './types'

type Listener = (chunk: UIStreamChunk) => void
type StateListener = (state: 'connecting' | 'connected' | 'disconnected') => void

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

const WS_OPEN = 1

export class WebSocketChatTransport {
  private ws: BrowserWebSocket | null = null
  private listeners: Set<Listener> = new Set()
  private stateListeners: Set<StateListener> = new Set()
  private _state: 'connecting' | 'connected' | 'disconnected' = 'disconnected'

  constructor(private sessionId: string) {}

  get state() {
    return this._state
  }

  connect() {
    this._state = 'connecting'
    this.notifyState()

    // @ts-expect-error — browser-only: window.location and WebSocket
    const loc = window.location
    const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${loc.host}/api/sessions/${this.sessionId}/ws`
    // @ts-expect-error — browser-only: native WebSocket constructor
    this.ws = new WebSocket(wsUrl) as BrowserWebSocket

    this.ws.onopen = () => {
      this._state = 'connected'
      this.notifyState()
    }

    this.ws.onmessage = (event) => {
      try {
        const chunk = JSON.parse(event.data as string) as UIStreamChunk
        for (const listener of this.listeners) {
          listener(chunk)
        }
      } catch {
        // Ignore parse errors
      }
    }

    this.ws.onclose = () => {
      this._state = 'disconnected'
      this.notifyState()
    }

    this.ws.onerror = () => {
      this._state = 'disconnected'
      this.notifyState()
    }
  }

  disconnect() {
    this.ws?.close()
    this.ws = null
    this._state = 'disconnected'
    this.notifyState()
  }

  send(command: BrowserCommand) {
    if (this.ws?.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(command))
    }
  }

  sendMessage(content: string) {
    this.send({ type: 'user-message', content })
  }

  sendToolApproval(
    toolCallId: string,
    approved: boolean,
    answers?: Record<string, string>,
  ) {
    this.send({ type: 'tool-approval', toolCallId, approved, answers })
  }

  onChunk(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  private notifyState() {
    for (const listener of this.stateListeners) {
      listener(this._state)
    }
  }
}
