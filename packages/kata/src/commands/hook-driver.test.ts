import { describe, it, expect } from 'bun:test'
import { codexDriver } from '../drivers/codex.js'
import { claudeDriver } from '../drivers/claude.js'

// ---------------------------------------------------------------------------
// 1. codex parseHookInput — full PreToolUse stdin with apply_patch reverse-map
// ---------------------------------------------------------------------------
describe('codexDriver.parseHookInput', () => {
  it('translates full codex PreToolUse stdin with apply_patch -> Edit', () => {
    const codexStdin = JSON.stringify({
      session_id: 'abc-123',
      transcript_path: '/tmp/sessions/abc-123.jsonl',
      cwd: '/data/projects/test',
      hook_event_name: 'PreToolUse',
      model: 'gpt-5-codex',
      tool_name: 'apply_patch',
      tool_input: { path: 'src/foo.ts', patch: '@@ ...' },
    })
    const input = codexDriver.parseHookInput(codexStdin, 'PreToolUse')
    expect(input.event).toBe('PreToolUse')
    expect(input.sessionId).toBe('abc-123')
    expect(input.cwd).toBe('/data/projects/test')
    expect(input.toolName).toBe('Edit')
    expect(input.model).toBe('gpt-5-codex')
    expect(input.transcriptPath).toBe('/tmp/sessions/abc-123.jsonl')
    expect(input.toolInput).toEqual({ path: 'src/foo.ts', patch: '@@ ...' })
  })

  it('preserves unknown tool names as-is', () => {
    const input = codexDriver.parseHookInput(
      JSON.stringify({ tool_name: 'custom_tool', session_id: 's1', cwd: '/tmp' }),
      'PreToolUse',
    )
    expect(input.toolName).toBe('custom_tool')
  })

  it('falls back to event arg when hook_event_name absent', () => {
    const input = codexDriver.parseHookInput(
      JSON.stringify({ session_id: 's1', cwd: '/tmp' }),
      'SessionStart',
    )
    expect(input.event).toBe('SessionStart')
  })
})

// ---------------------------------------------------------------------------
// 2. claude parseHookInput — pass-through preserves native shape
// ---------------------------------------------------------------------------
describe('claudeDriver.parseHookInput', () => {
  it('is pass-through for native Claude shape', () => {
    const claudeStdin = JSON.stringify({
      session_id: 'sess-456',
      cwd: '/data/projects/test',
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/bar.ts' },
    })
    const input = claudeDriver.parseHookInput(claudeStdin, 'PreToolUse')
    expect(input.event).toBe('PreToolUse')
    expect(input.sessionId).toBe('sess-456')
    expect(input.toolName).toBe('Edit')
    expect(input.cwd).toBe('/data/projects/test')
  })

  it('preserves all optional fields', () => {
    const claudeStdin = JSON.stringify({
      session_id: 'sess-789',
      cwd: '/tmp',
      hook_event_name: 'Stop',
      stop_hook_active: true,
      transcript_path: '/tmp/transcript.jsonl',
      model: 'claude-sonnet-4-20250514',
      prompt: 'do something',
    })
    const input = claudeDriver.parseHookInput(claudeStdin, 'Stop')
    expect(input.stopHookActive).toBe(true)
    expect(input.transcriptPath).toBe('/tmp/transcript.jsonl')
    expect(input.model).toBe('claude-sonnet-4-20250514')
    expect(input.prompt).toBe('do something')
  })
})

// ---------------------------------------------------------------------------
// 3. codex formatHookOutput — PreToolUse block produces deny + exit 2
// ---------------------------------------------------------------------------
describe('codexDriver.formatHookOutput — PreToolUse', () => {
  it('block produces deny with exit 2', () => {
    const result = codexDriver.formatHookOutput(
      { decision: 'block', reason: 'planning mode blocks edits' },
      'PreToolUse',
    )
    expect(result.exitCode).toBe(2)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.permissionDecision).toBe('deny')
    expect(parsed.stopReason).toBe('planning mode blocks edits')
  })

  it('allow produces empty stdout with exit 0', () => {
    const result = codexDriver.formatHookOutput(
      { decision: 'allow' },
      'PreToolUse',
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 4. claude formatHookOutput — always returns exit 0
// ---------------------------------------------------------------------------
describe('claudeDriver.formatHookOutput', () => {
  it('always returns exit 0 even for block', () => {
    const result = claudeDriver.formatHookOutput(
      { decision: 'block', reason: 'test' },
      'PreToolUse',
    )
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.decision).toBe('block')
    expect(parsed.reason).toBe('test')
  })

  it('allow also returns exit 0', () => {
    const result = claudeDriver.formatHookOutput(
      { decision: 'allow' },
      'PreToolUse',
    )
    expect(result.exitCode).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. codex SessionStart with additionalContext produces systemMessage
// ---------------------------------------------------------------------------
describe('codexDriver.formatHookOutput — SessionStart', () => {
  it('additionalContext produces systemMessage with continue: true', () => {
    const result = codexDriver.formatHookOutput(
      { additionalContext: 'You are in task mode' },
      'SessionStart',
    )
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.systemMessage).toBe('You are in task mode')
    expect(parsed.continue).toBe(true)
  })

  it('empty output produces empty stdout', () => {
    const result = codexDriver.formatHookOutput({}, 'SessionStart')
    expect(result.stdout).toBe('')
    expect(result.exitCode).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. Both drivers resolve Edit for edit operations (canonical convergence)
// ---------------------------------------------------------------------------
describe('canonical tool name convergence', () => {
  it('both drivers resolve to Edit for edit operations', () => {
    const claudeInput = claudeDriver.parseHookInput(
      JSON.stringify({ tool_name: 'Edit', hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/tmp' }),
      'PreToolUse',
    )
    const codexInput = codexDriver.parseHookInput(
      JSON.stringify({ tool_name: 'apply_patch', hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/tmp' }),
      'PreToolUse',
    )
    expect(claudeInput.toolName).toBe('Edit')
    expect(codexInput.toolName).toBe('Edit')
  })

  it('both drivers resolve Bash identically', () => {
    const claudeInput = claudeDriver.parseHookInput(
      JSON.stringify({ tool_name: 'Bash', hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/tmp' }),
      'PreToolUse',
    )
    const codexInput = codexDriver.parseHookInput(
      JSON.stringify({ tool_name: 'Bash', hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/tmp' }),
      'PreToolUse',
    )
    expect(claudeInput.toolName).toBe('Bash')
    expect(codexInput.toolName).toBe('Bash')
  })
})

// ---------------------------------------------------------------------------
// 7. codex formatHookOutput — Stop event with block
// ---------------------------------------------------------------------------
describe('codexDriver.formatHookOutput — Stop', () => {
  it('block returns exit 0 with continue: true', () => {
    const result = codexDriver.formatHookOutput(
      { decision: 'block', reason: 'tasks incomplete' },
      'Stop',
    )
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.continue).toBe(true)
    expect(parsed.stopReason).toBe('tasks incomplete')
  })
})

// ---------------------------------------------------------------------------
// 8. codex UserPromptSubmit with additionalContext
// ---------------------------------------------------------------------------
describe('codexDriver.formatHookOutput — UserPromptSubmit', () => {
  it('additionalContext produces systemMessage', () => {
    const result = codexDriver.formatHookOutput(
      { additionalContext: 'Mode reminder injected' },
      'UserPromptSubmit',
    )
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.systemMessage).toBe('Mode reminder injected')
    expect(parsed.continue).toBe(true)
  })
})
