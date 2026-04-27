import { describe, it, expect } from 'bun:test'
import { homedir } from 'node:os'
import { getDriver, listDrivers, getUserSettingsPath } from './index.js'
import { DRIVER_TASK_ENV_VARS, isNativeTasksEnabled } from '../utils/tasks-check.js'
import { getDefaultProvider } from '../config/kata-config.js'

// ---------------------------------------------------------------------------
// 1. Driver registry
// ---------------------------------------------------------------------------
describe('driver registry', () => {
  it('getDriver("claude").name === "claude"', () => {
    expect(getDriver('claude').name).toBe('claude')
  })

  it('getDriver("codex").name === "codex"', () => {
    expect(getDriver('codex').name).toBe('codex')
  })

  it('listDrivers() returns exactly 2 entries', () => {
    expect(listDrivers().length).toBe(2)
  })

  it('listDrivers() contains both claude and codex', () => {
    const names = listDrivers().map((d) => d.name)
    expect(names).toContain('claude')
    expect(names).toContain('codex')
  })
})

// ---------------------------------------------------------------------------
// 2. hookEventName — identity / pass-through (B5)
// ---------------------------------------------------------------------------
describe('hookEventName — identity pass-through', () => {
  it('claude: PreToolUse -> PreToolUse', () => {
    expect(getDriver('claude').hookEventName('PreToolUse')).toBe('PreToolUse')
  })

  it('codex: PreToolUse -> PreToolUse', () => {
    expect(getDriver('codex').hookEventName('PreToolUse')).toBe('PreToolUse')
  })

  it('claude: SessionStart -> SessionStart', () => {
    expect(getDriver('claude').hookEventName('SessionStart')).toBe('SessionStart')
  })

  it('codex: Stop -> Stop', () => {
    expect(getDriver('codex').hookEventName('Stop')).toBe('Stop')
  })
})

// ---------------------------------------------------------------------------
// 3. getUserSettingsPath (B4)
// ---------------------------------------------------------------------------
describe('getUserSettingsPath', () => {
  it('claude path ends with .claude/settings.json', () => {
    const p = getUserSettingsPath(getDriver('claude'))
    expect(p.endsWith('.claude/settings.json')).toBe(true)
  })

  it('codex path ends with .codex/hooks.json', () => {
    const p = getUserSettingsPath(getDriver('codex'))
    expect(p.endsWith('.codex/hooks.json')).toBe(true)
  })

  it('claude path starts with home dir', () => {
    const p = getUserSettingsPath(getDriver('claude'))
    expect(p.startsWith(homedir())).toBe(true)
  })

  it('codex path starts with home dir', () => {
    const p = getUserSettingsPath(getDriver('codex'))
    expect(p.startsWith(homedir())).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. skillInvocationPrefix
// ---------------------------------------------------------------------------
describe('skillInvocationPrefix', () => {
  it('claude returns "/"', () => {
    expect(getDriver('claude').skillInvocationPrefix()).toBe('/')
  })

  it('codex returns "$"', () => {
    expect(getDriver('codex').skillInvocationPrefix()).toBe('$')
  })
})

// ---------------------------------------------------------------------------
// 5. ceremonyFileName
// ---------------------------------------------------------------------------
describe('ceremonyFileName', () => {
  it('claude returns "CLAUDE.md"', () => {
    expect(getDriver('claude').ceremonyFileName()).toBe('CLAUDE.md')
  })

  it('codex returns "AGENTS.md"', () => {
    expect(getDriver('codex').ceremonyFileName()).toBe('AGENTS.md')
  })
})

// ---------------------------------------------------------------------------
// 6. DRIVER_TASK_ENV_VARS (B3)
// ---------------------------------------------------------------------------
describe('DRIVER_TASK_ENV_VARS', () => {
  it('claude maps to CLAUDE_CODE_ENABLE_TASKS', () => {
    expect(DRIVER_TASK_ENV_VARS['claude']).toBe('CLAUDE_CODE_ENABLE_TASKS')
  })

  it('codex maps to null (no gate)', () => {
    expect(DRIVER_TASK_ENV_VARS['codex']).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 7. isNativeTasksEnabled with driver param (B3 — backwards compat)
// ---------------------------------------------------------------------------
describe('isNativeTasksEnabled', () => {
  it('isNativeTasksEnabled("codex") returns true (no gate)', () => {
    expect(isNativeTasksEnabled('codex')).toBe(true)
  })

  it('isNativeTasksEnabled() defaults to true (no env var set)', () => {
    // Ensure the env var is not set for this test
    const prev = process.env['CLAUDE_CODE_ENABLE_TASKS']
    delete process.env['CLAUDE_CODE_ENABLE_TASKS']
    try {
      expect(isNativeTasksEnabled()).toBe(true)
    } finally {
      if (prev !== undefined) process.env['CLAUDE_CODE_ENABLE_TASKS'] = prev
    }
  })
})

// ---------------------------------------------------------------------------
// 8. getDefaultProvider fallback (B2)
// ---------------------------------------------------------------------------
describe('getDefaultProvider', () => {
  it('returns "claude" when outside a kata project', () => {
    // In the test environment there is no kata.yaml, so the fallback kicks in
    expect(getDefaultProvider()).toBe('claude')
  })
})
