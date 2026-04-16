import { describe, expect, it } from 'vitest'
import { AdapterRegistry } from './registry.js'
import type { AdapterCapabilities, AgentAdapter } from './types.js'

/** Minimal mock adapter for registry tests */
function createMockAdapter(name: string, available = true): AgentAdapter {
  return {
    name,
    async execute() {},
    async resume() {},
    abort() {},
    async getCapabilities(): Promise<AdapterCapabilities> {
      return {
        agent: name,
        available,
        supportedCommands: ['execute'],
        description: `${name} adapter`,
      }
    },
  }
}

describe('AdapterRegistry', () => {
  it('returns undefined for unregistered adapter', () => {
    const registry = new AdapterRegistry()
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  it('registers and retrieves an adapter by name', () => {
    const registry = new AdapterRegistry()
    const adapter = createMockAdapter('claude')
    registry.register(adapter)

    expect(registry.get('claude')).toBe(adapter)
  })

  it('overwrites adapter when registering with the same name', () => {
    const registry = new AdapterRegistry()
    const first = createMockAdapter('claude')
    const second = createMockAdapter('claude')
    registry.register(first)
    registry.register(second)

    expect(registry.get('claude')).toBe(second)
    expect(registry.get('claude')).not.toBe(first)
  })

  it('supports multiple adapters', () => {
    const registry = new AdapterRegistry()
    const claude = createMockAdapter('claude')
    const codex = createMockAdapter('codex')
    registry.register(claude)
    registry.register(codex)

    expect(registry.get('claude')).toBe(claude)
    expect(registry.get('codex')).toBe(codex)
  })

  describe('listNames', () => {
    it('returns empty array when no adapters registered', () => {
      const registry = new AdapterRegistry()
      expect(registry.listNames()).toEqual([])
    })

    it('returns names of all registered adapters', () => {
      const registry = new AdapterRegistry()
      registry.register(createMockAdapter('claude'))
      registry.register(createMockAdapter('codex'))
      registry.register(createMockAdapter('opencode'))

      const names = registry.listNames()
      expect(names).toContain('claude')
      expect(names).toContain('codex')
      expect(names).toContain('opencode')
      expect(names).toHaveLength(3)
    })
  })

  describe('listCapabilities', () => {
    it('returns empty array when no adapters registered', async () => {
      const registry = new AdapterRegistry()
      const caps = await registry.listCapabilities()
      expect(caps).toEqual([])
    })

    it('returns capabilities from all registered adapters', async () => {
      const registry = new AdapterRegistry()
      registry.register(createMockAdapter('claude', true))
      registry.register(createMockAdapter('codex', false))

      const caps = await registry.listCapabilities()

      expect(caps).toHaveLength(2)
      expect(caps[0].agent).toBe('claude')
      expect(caps[0].available).toBe(true)
      expect(caps[1].agent).toBe('codex')
      expect(caps[1].available).toBe(false)
    })

    it('resolves all capabilities concurrently', async () => {
      const registry = new AdapterRegistry()
      registry.register(createMockAdapter('a'))
      registry.register(createMockAdapter('b'))
      registry.register(createMockAdapter('c'))

      const caps = await registry.listCapabilities()
      expect(caps).toHaveLength(3)
      expect(caps.map((c) => c.agent)).toEqual(['a', 'b', 'c'])
    })
  })
})
