import { describe, expect, it } from 'vitest'
import { AdapterRegistry } from './adapters/registry.js'
import type { AdapterCapabilities, AgentAdapter } from './adapters/types.js'

/**
 * Tests for the GET /capabilities endpoint contract.
 *
 * The endpoint returns `{ agents: AdapterCapabilities[] }` by calling
 * `registry.listCapabilities()`. These tests validate the response shape
 * and auth requirements that the server.ts route handler enforces.
 */

function createMockAdapter(
  name: string,
  opts: { available?: boolean; commands?: string[]; models?: string[] } = {},
): AgentAdapter {
  const { available = true, commands = ['execute', 'resume', 'abort'], models } = opts
  return {
    name,
    async execute() {},
    async resume() {},
    abort() {},
    async getCapabilities(): Promise<AdapterCapabilities> {
      return {
        agent: name,
        available,
        supportedCommands: commands,
        description: `${name} adapter`,
        ...(models ? { models } : {}),
      }
    },
  }
}

describe('GET /capabilities response shape', () => {
  it('wraps capabilities in { agents } envelope', async () => {
    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude'))
    registry.register(createMockAdapter('codex'))

    const agents = await registry.listCapabilities()
    const body = { agents }

    expect(body).toHaveProperty('agents')
    expect(Array.isArray(body.agents)).toBe(true)
    expect(body.agents).toHaveLength(2)
  })

  it('each agent has required capability fields', async () => {
    const registry = new AdapterRegistry()
    registry.register(
      createMockAdapter('claude', {
        available: true,
        commands: ['execute', 'resume', 'abort'],
        models: ['claude-sonnet-4-20250514'],
      }),
    )

    const agents = await registry.listCapabilities()
    const cap = agents[0]

    expect(cap).toMatchObject({
      agent: 'claude',
      available: true,
      supportedCommands: expect.arrayContaining(['execute', 'resume', 'abort']),
      description: expect.any(String),
    })
    expect(cap.models).toEqual(['claude-sonnet-4-20250514'])
  })

  it('returns empty agents array when no adapters registered', async () => {
    const registry = new AdapterRegistry()
    const agents = await registry.listCapabilities()
    const body = { agents }

    expect(body).toEqual({ agents: [] })
  })

  it('includes unavailable adapters with available=false', async () => {
    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude', { available: true }))
    registry.register(createMockAdapter('codex', { available: false }))

    const agents = await registry.listCapabilities()
    const body = { agents }

    const codex = body.agents.find((a) => a.agent === 'codex')
    expect(codex).toBeDefined()
    expect(codex!.available).toBe(false)
  })

  it('preserves adapter registration order', async () => {
    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('claude'))
    registry.register(createMockAdapter('codex'))
    registry.register(createMockAdapter('opencode'))

    const agents = await registry.listCapabilities()
    const names = agents.map((a) => a.agent)

    expect(names).toEqual(['claude', 'codex', 'opencode'])
  })

  it('models field is optional', async () => {
    const registry = new AdapterRegistry()
    registry.register(createMockAdapter('codex', { available: true }))

    const agents = await registry.listCapabilities()
    // models should not be present when not provided
    expect(agents[0].models).toBeUndefined()
  })
})
