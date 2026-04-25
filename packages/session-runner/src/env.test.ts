import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCleanEnv } from './env.js'

describe('buildCleanEnv', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    // Strip any pre-existing values that the suite cares about so individual
    // tests start from a clean slate.
    delete process.env.CLAUDECODE_RUNNING
    delete process.env.CLAUDE_CODE_ENTRYPOINT
    delete process.env.ENABLE_TOOL_SEARCH
  })

  afterEach(() => {
    // Restore the original env so other suites aren't affected.
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k]
    }
    Object.assign(process.env, savedEnv)
  })

  it('strips CLAUDECODE* vars so the SDK does not detect a nested session', () => {
    process.env.CLAUDECODE_RUNNING = '1'
    process.env.CLAUDECODE_FOO = 'bar'
    const env = buildCleanEnv()
    expect(env.CLAUDECODE_RUNNING).toBeUndefined()
    expect(env.CLAUDECODE_FOO).toBeUndefined()
  })

  it('strips CLAUDE_CODE_ENTRYPOINT', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    const env = buildCleanEnv()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
  })

  it('forces ENABLE_TOOL_SEARCH=100 so AskUserQuestion is not deferred', () => {
    // Default case: env var not set
    const env = buildCleanEnv()
    expect(env.ENABLE_TOOL_SEARCH).toBe('100')
  })

  it('overrides any inherited ENABLE_TOOL_SEARCH value', () => {
    // Even if the parent shell exported tool-search mode, we must override —
    // otherwise the agent loops on AskUserQuestion strict-Zod validation
    // failures (claude-agent-sdk@0.2.98 deferred-tools behavior).
    process.env.ENABLE_TOOL_SEARCH = '0' // would mean "tst" mode
    const env = buildCleanEnv()
    expect(env.ENABLE_TOOL_SEARCH).toBe('100')
  })

  it('passes through unrelated env vars unchanged', () => {
    process.env.FOO_BAR = 'baz'
    const env = buildCleanEnv()
    expect(env.FOO_BAR).toBe('baz')
  })
})
