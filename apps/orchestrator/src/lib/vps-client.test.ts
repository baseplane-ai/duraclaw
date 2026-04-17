import { describe, expect, it } from 'vitest'
import { parseEvent } from './vps-client'

describe('parseEvent', () => {
  it('parses a JSON string into a GatewayEvent', () => {
    const event = parseEvent('{"type":"session.init","session_id":"s1","model":"claude"}')
    expect(event).toEqual({ type: 'session.init', session_id: 's1', model: 'claude' })
  })

  it('parses an ArrayBuffer into a GatewayEvent', () => {
    const json = '{"type":"result","session_id":"s1","status":"completed"}'
    const buf = new TextEncoder().encode(json).buffer
    const event = parseEvent(buf)
    expect(event).toEqual({ type: 'result', session_id: 's1', status: 'completed' })
  })

  it('throws on invalid JSON', () => {
    expect(() => parseEvent('not-json')).toThrow()
  })

  it('does not export connectToExecutor or sendCommand (dead code removed)', async () => {
    const mod = await import('./vps-client')
    expect(mod).not.toHaveProperty('connectToExecutor')
    expect(mod).not.toHaveProperty('sendCommand')
  })

  it('exports parseEvent and getSessionStatus (no dead legacy helpers)', async () => {
    const mod = await import('./vps-client')
    const exportedKeys = Object.keys(mod).sort()
    // Intentional allow-list — guards against accidental re-introduction of
    // the old connectToExecutor/sendCommand helpers (see spec #1 P1.5).
    expect(exportedKeys).toEqual(['getSessionStatus', 'parseEvent'])
  })
})
