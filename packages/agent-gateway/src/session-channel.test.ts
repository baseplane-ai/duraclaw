import { describe, expect, it, vi } from 'vitest'
import type { SessionChannel } from './session-channel.js'
import { fromServerWebSocket, fromWebSocket, ReconnectableChannel } from './session-channel.js'

describe('fromServerWebSocket', () => {
  function createMockServerWs() {
    return {
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
      data: { project: 'test' },
    }
  }

  it('delegates send() to the underlying ServerWebSocket', () => {
    const mock = createMockServerWs()
    const ch: SessionChannel = fromServerWebSocket(mock as any)

    ch.send('hello')

    expect(mock.send).toHaveBeenCalledWith('hello')
  })

  it('delegates close() to the underlying ServerWebSocket', () => {
    const mock = createMockServerWs()
    const ch: SessionChannel = fromServerWebSocket(mock as any)

    ch.close(1000, 'normal')

    expect(mock.close).toHaveBeenCalledWith(1000, 'normal')
  })

  it('delegates close() without arguments', () => {
    const mock = createMockServerWs()
    const ch: SessionChannel = fromServerWebSocket(mock as any)

    ch.close()

    expect(mock.close).toHaveBeenCalledWith(undefined, undefined)
  })

  it('exposes readyState from the underlying ServerWebSocket', () => {
    const mock = createMockServerWs()
    const ch: SessionChannel = fromServerWebSocket(mock as any)

    expect(ch.readyState).toBe(1)
  })

  it('reflects readyState changes from the underlying ServerWebSocket', () => {
    const mock = createMockServerWs()
    const ch: SessionChannel = fromServerWebSocket(mock as any)

    expect(ch.readyState).toBe(1)
    mock.readyState = 3
    expect(ch.readyState).toBe(3)
  })
})

describe('fromWebSocket', () => {
  function createMockWebSocket() {
    return {
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
    }
  }

  it('delegates send() to the underlying WebSocket', () => {
    const mock = createMockWebSocket()
    const ch: SessionChannel = fromWebSocket(mock as any)

    ch.send('{"type":"test"}')

    expect(mock.send).toHaveBeenCalledWith('{"type":"test"}')
  })

  it('delegates close() to the underlying WebSocket', () => {
    const mock = createMockWebSocket()
    const ch: SessionChannel = fromWebSocket(mock as any)

    ch.close(1001, 'going away')

    expect(mock.close).toHaveBeenCalledWith(1001, 'going away')
  })

  it('exposes readyState from the underlying WebSocket', () => {
    const mock = createMockWebSocket()
    const ch: SessionChannel = fromWebSocket(mock as any)

    expect(ch.readyState).toBe(1)
  })

  it('reflects readyState changes from the underlying WebSocket', () => {
    const mock = createMockWebSocket()
    const ch: SessionChannel = fromWebSocket(mock as any)

    expect(ch.readyState).toBe(1)
    mock.readyState = 0
    expect(ch.readyState).toBe(0)
  })
})

describe('ReconnectableChannel', () => {
  function createMockWebSocket() {
    return {
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
    }
  }

  it('delegates send() to the underlying WebSocket', () => {
    const mock = createMockWebSocket()
    const ch = new ReconnectableChannel(mock as any)

    ch.send('hello')

    expect(mock.send).toHaveBeenCalledWith('hello')
  })

  it('delegates close() to the underlying WebSocket', () => {
    const mock = createMockWebSocket()
    const ch = new ReconnectableChannel(mock as any)

    ch.close(1000, 'normal')

    expect(mock.close).toHaveBeenCalledWith(1000, 'normal')
  })

  it('exposes readyState from the underlying WebSocket', () => {
    const mock = createMockWebSocket()
    const ch = new ReconnectableChannel(mock as any)

    expect(ch.readyState).toBe(1)
  })

  it('replaceWebSocket swaps the underlying WS', () => {
    const ws1 = createMockWebSocket()
    const ws2 = createMockWebSocket()
    const ch = new ReconnectableChannel(ws1 as any)

    ch.send('to-ws1')
    expect(ws1.send).toHaveBeenCalledWith('to-ws1')

    ch.replaceWebSocket(ws2 as any)

    ch.send('to-ws2')
    expect(ws2.send).toHaveBeenCalledWith('to-ws2')
    // ws1 should not receive the second message
    expect(ws1.send).toHaveBeenCalledTimes(1)
  })

  it('readyState reflects the new WS after replace', () => {
    const ws1 = createMockWebSocket()
    ws1.readyState = 3 // CLOSED
    const ws2 = createMockWebSocket()
    ws2.readyState = 1 // OPEN

    const ch = new ReconnectableChannel(ws1 as any)
    expect(ch.readyState).toBe(3)

    ch.replaceWebSocket(ws2 as any)
    expect(ch.readyState).toBe(1)
  })

  it('satisfies the SessionChannel interface', () => {
    const mock = createMockWebSocket()
    const ch: SessionChannel = new ReconnectableChannel(mock as any)

    ch.send('msg')
    expect(mock.send).toHaveBeenCalledWith('msg')
  })
})

describe('SessionChannel interface conformance', () => {
  it('both wrappers produce objects satisfying the same interface', () => {
    const serverWs = { send: vi.fn(), close: vi.fn(), readyState: 1, data: { project: null } }
    const clientWs = { send: vi.fn(), close: vi.fn(), readyState: 1 }

    const ch1: SessionChannel = fromServerWebSocket(serverWs as any)
    const ch2: SessionChannel = fromWebSocket(clientWs as any)

    // Both should work identically
    ch1.send('msg')
    ch2.send('msg')
    expect(serverWs.send).toHaveBeenCalledWith('msg')
    expect(clientWs.send).toHaveBeenCalledWith('msg')

    ch1.close(1000)
    ch2.close(1000)
    expect(serverWs.close).toHaveBeenCalledWith(1000, undefined)
    expect(clientWs.close).toHaveBeenCalledWith(1000, undefined)
  })
})
