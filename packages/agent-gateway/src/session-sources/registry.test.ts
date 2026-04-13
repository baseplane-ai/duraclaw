import { describe, expect, it } from 'vitest'
import { SessionSourceRegistry } from './registry.js'
import type { DiscoveredSession, SessionSource } from './types.js'

function createMockSource(agent: string, available = true): SessionSource {
  return {
    agent,
    description: `${agent} sessions`,
    async available() {
      return available
    },
    async discoverSessions() {
      return []
    },
  }
}

describe('SessionSourceRegistry', () => {
  it('returns undefined for unregistered source', () => {
    const registry = new SessionSourceRegistry()
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  it('registers and retrieves a source by agent name', () => {
    const registry = new SessionSourceRegistry()
    const source = createMockSource('claude')
    registry.register(source)

    expect(registry.get('claude')).toBe(source)
  })

  it('overwrites source when registering with the same agent name', () => {
    const registry = new SessionSourceRegistry()
    const first = createMockSource('claude')
    const second = createMockSource('claude')
    registry.register(first)
    registry.register(second)

    expect(registry.get('claude')).toBe(second)
    expect(registry.get('claude')).not.toBe(first)
  })

  it('supports multiple sources', () => {
    const registry = new SessionSourceRegistry()
    const claude = createMockSource('claude')
    const codex = createMockSource('codex')
    registry.register(claude)
    registry.register(codex)

    expect(registry.get('claude')).toBe(claude)
    expect(registry.get('codex')).toBe(codex)
  })

  describe('listSources', () => {
    it('returns empty array when no sources registered', () => {
      const registry = new SessionSourceRegistry()
      expect(registry.listSources()).toEqual([])
    })

    it('returns all registered sources', () => {
      const registry = new SessionSourceRegistry()
      const claude = createMockSource('claude')
      const codex = createMockSource('codex')
      const opencode = createMockSource('opencode')
      registry.register(claude)
      registry.register(codex)
      registry.register(opencode)

      const sources = registry.listSources()
      expect(sources).toHaveLength(3)
      expect(sources.map((s) => s.agent)).toContain('claude')
      expect(sources.map((s) => s.agent)).toContain('codex')
      expect(sources.map((s) => s.agent)).toContain('opencode')
    })
  })
})
