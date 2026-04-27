import { describe, it, expect } from 'bun:test'
import { claudeDriver } from './claude.js'
import { codexDriver } from './codex.js'
import { SessionStateSchema } from '../state/schema.js'

// ---------------------------------------------------------------------------
// 1. claudeDriver.formatHookOutput
// ---------------------------------------------------------------------------
describe('claudeDriver.formatHookOutput', () => {
  it('block decision returns exitCode 0 (Claude reads from JSON body)', () => {
    const result = claudeDriver.formatHookOutput(
      { decision: 'block', reason: 'test' },
      'PreToolUse',
    )
    expect(result.exitCode).toBe(0)
  })

  it('parsed stdout contains decision: block', () => {
    const result = claudeDriver.formatHookOutput(
      { decision: 'block', reason: 'test' },
      'PreToolUse',
    )
    const parsed = JSON.parse(result.stdout)
    expect(parsed.decision).toBe('block')
  })
})

// ---------------------------------------------------------------------------
// 2. codexDriver.formatHookOutput
// ---------------------------------------------------------------------------
describe('codexDriver.formatHookOutput', () => {
  it('PreToolUse with block returns exitCode 2 and permissionDecision deny', () => {
    const result = codexDriver.formatHookOutput(
      { decision: 'block', reason: 'forbidden' },
      'PreToolUse',
    )
    expect(result.exitCode).toBe(2)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.permissionDecision).toBe('deny')
  })

  it('SessionStart with additionalContext returns exitCode 0 and systemMessage', () => {
    const result = codexDriver.formatHookOutput(
      { additionalContext: 'hello' },
      'SessionStart',
    )
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.systemMessage).toBe('hello')
    expect(parsed.continue).toBe(true)
  })

  it('Stop with block returns exitCode 0 and continue: true', () => {
    const result = codexDriver.formatHookOutput(
      { decision: 'block', reason: 'not done' },
      'Stop',
    )
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.continue).toBe(true)
  })

  it('PreToolUse with no decision returns empty stdout and exitCode 0', () => {
    const result = codexDriver.formatHookOutput({}, 'PreToolUse')
    expect(result.stdout).toBe('')
    expect(result.exitCode).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. codexDriver.parseHookInput
// ---------------------------------------------------------------------------
describe('codexDriver.parseHookInput', () => {
  it('reverse-maps apply_patch to canonical Edit', () => {
    const input = codexDriver.parseHookInput(
      JSON.stringify({ tool_name: 'apply_patch', session_id: 's1', cwd: '/tmp' }),
      'PreToolUse',
    )
    expect(input.toolName).toBe('Edit')
  })

  it('Bash stays as Bash (identity mapping)', () => {
    const input = codexDriver.parseHookInput(
      JSON.stringify({ tool_name: 'Bash', session_id: 's2', cwd: '/tmp' }),
      'PreToolUse',
    )
    expect(input.toolName).toBe('Bash')
  })

  it('no tool_name returns undefined for toolName', () => {
    const input = codexDriver.parseHookInput(
      JSON.stringify({ session_id: 's3', cwd: '/tmp' }),
      'SessionStart',
    )
    expect(input.toolName).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4–5. writeHookRegistration / removeHookRegistration — skipped
// Filesystem-modifying tests are covered by setup.test.ts integration tests.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6. SessionState driver field (B26)
// ---------------------------------------------------------------------------
describe('SessionState driver field', () => {
  it('defaults to claude when driver field is absent', () => {
    const parsed = SessionStateSchema.parse({ sessionId: undefined })
    expect(parsed.driver).toBe('claude')
  })

  it('preserves codex when explicitly set', () => {
    const parsed = SessionStateSchema.parse({ driver: 'codex' })
    expect(parsed.driver).toBe('codex')
  })

  it('preserves claude when explicitly set', () => {
    const parsed = SessionStateSchema.parse({ driver: 'claude' })
    expect(parsed.driver).toBe('claude')
  })
})
