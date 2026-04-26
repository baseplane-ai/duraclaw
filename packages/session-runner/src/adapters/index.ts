import type { AgentName } from '@duraclaw/shared-types'
import { ClaudeAdapter } from './claude.js'
import { CodexAdapter } from './codex.js'
import type { RunnerAdapter } from './types.js'

/**
 * GH#107 / spec 107-codex-runner-revival B1: factory registry keyed by
 * `AgentName`. P1.1 shipped with `claude` only; P3 wires `codex` to the
 * `@openai/codex-sdk`-backed `CodexAdapter`.
 */
const registry: Partial<Record<AgentName, () => RunnerAdapter>> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
}

export function createAdapter(agent: AgentName | undefined): RunnerAdapter {
  const name: AgentName = agent ?? 'claude'
  const factory = registry[name]
  if (!factory) {
    throw new Error(`unknown_agent:${name}`)
  }
  return factory()
}

export { CLAUDE_CAPABILITIES, ClaudeAdapter } from './claude.js'
export type { AdapterStartOptions, RunnerAdapter } from './types.js'
