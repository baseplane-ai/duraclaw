import { describe, expect, it } from 'vitest'
import {
  deriveProjectAbbrev,
  deriveProjectColorSlot,
  deriveRepoBase,
  deriveSessionSuffix,
  formatTabLabel,
  PROJECT_COLOR_SLOTS,
  parseWorktreeSuffix,
  statusRingClass,
  UNASSIGNED_COLOR_SLOT,
} from './project-display'

describe('deriveRepoBase', () => {
  it('strips -devN', () => {
    expect(deriveRepoBase('duraclaw-dev3')).toBe('duraclaw')
    expect(deriveRepoBase('duraclaw-dev11')).toBe('duraclaw')
  })
  it('strips -N', () => {
    expect(deriveRepoBase('repo-2')).toBe('repo')
  })
  it('strips -wip', () => {
    expect(deriveRepoBase('project-wip')).toBe('project')
    expect(deriveRepoBase('project-wip2')).toBe('project')
  })
  it('leaves canonical names alone', () => {
    expect(deriveRepoBase('duraclaw')).toBe('duraclaw')
    expect(deriveRepoBase('my-project')).toBe('my-project')
  })
  it('empty → empty', () => {
    expect(deriveRepoBase('')).toBe('')
  })
})

describe('deriveProjectAbbrev', () => {
  it('single word: first char + first consonant', () => {
    expect(deriveProjectAbbrev('duraclaw')).toBe('DC')
    expect(deriveProjectAbbrev('foo')).toBe('FO')
  })
  it('multi-word: two initials', () => {
    expect(deriveProjectAbbrev('my-project')).toBe('MP')
    expect(deriveProjectAbbrev('agent_gateway')).toBe('AG')
    expect(deriveProjectAbbrev('my project')).toBe('MP')
  })
  it('all-vowel word: falls back to second char', () => {
    expect(deriveProjectAbbrev('aeo')).toBe('AE')
  })
  it('single char → single char uppercased', () => {
    expect(deriveProjectAbbrev('x')).toBe('X')
  })
  it('empty → fallback', () => {
    expect(deriveProjectAbbrev('')).toBe('--')
  })
})

describe('parseWorktreeSuffix', () => {
  it('canonical worktree returns empty', () => {
    expect(parseWorktreeSuffix('duraclaw', 'duraclaw')).toBe('')
  })
  it('numeric dev worktrees return digit', () => {
    expect(parseWorktreeSuffix('duraclaw-dev1', 'duraclaw')).toBe('1')
    expect(parseWorktreeSuffix('duraclaw-dev3', 'duraclaw')).toBe('3')
  })
  it('auto-derives repo base when repoName omitted', () => {
    expect(parseWorktreeSuffix('duraclaw-dev2')).toBe('2')
    expect(parseWorktreeSuffix('duraclaw')).toBe('')
  })
  it('non-matching prefix returns empty', () => {
    expect(parseWorktreeSuffix('foo-bar', 'baz')).toBe('')
  })
  it('empty returns empty', () => {
    expect(parseWorktreeSuffix('')).toBe('')
  })
})

describe('deriveSessionSuffix', () => {
  it('N=1 returns empty', () => {
    expect(deriveSessionSuffix('s1', ['s1'])).toBe('')
  })
  it('empty siblings returns empty', () => {
    expect(deriveSessionSuffix('s1', [])).toBe('')
  })
  it('N=2 returns a, b', () => {
    expect(deriveSessionSuffix('s1', ['s1', 's2'])).toBe('a')
    expect(deriveSessionSuffix('s2', ['s1', 's2'])).toBe('b')
  })
  it('unknown session returns empty', () => {
    expect(deriveSessionSuffix('s9', ['s1', 's2'])).toBe('')
  })
  it('wraps past z with zN suffix', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `s${i}`)
    expect(deriveSessionSuffix('s0', ids)).toBe('a')
    expect(deriveSessionSuffix('s25', ids)).toBe('z')
    expect(deriveSessionSuffix('s26', ids)).toBe('z2')
    expect(deriveSessionSuffix('s29', ids)).toBe('z5')
  })
})

describe('deriveProjectColorSlot', () => {
  it('same input → same slot', () => {
    expect(deriveProjectColorSlot('duraclaw')).toEqual(deriveProjectColorSlot('duraclaw'))
  })
  it('stable across repeated calls', () => {
    const first = deriveProjectColorSlot('duraclaw')
    for (let i = 0; i < 10; i++) {
      expect(deriveProjectColorSlot('duraclaw')).toEqual(first)
    }
  })
  it('null / empty returns the dedicated unassigned slot (not a palette slot)', () => {
    expect(deriveProjectColorSlot('')).toEqual(UNASSIGNED_COLOR_SLOT)
    expect(deriveProjectColorSlot(null)).toEqual(UNASSIGNED_COLOR_SLOT)
    expect(deriveProjectColorSlot(undefined)).toEqual(UNASSIGNED_COLOR_SLOT)
    // And the unassigned slot must not appear in the hashable pool.
    for (const slot of PROJECT_COLOR_SLOTS) {
      expect(slot).not.toEqual(UNASSIGNED_COLOR_SLOT)
    }
  })
  it('literal string "undefined" hashes to a palette slot (not the fallback)', () => {
    const slot = deriveProjectColorSlot('undefined')
    expect(slot).not.toEqual(UNASSIGNED_COLOR_SLOT)
    expect(PROJECT_COLOR_SLOTS).toContainEqual(slot)
  })
  it('distinct repo keys typically map to distinct slots', () => {
    // duraclaw vs kata — chosen because their FNV-1a hashes land in
    // different palette buckets under the 10-slot pool.
    expect(deriveProjectColorSlot('duraclaw')).not.toEqual(deriveProjectColorSlot('kata'))
  })
  it('spreads distinct inputs across multiple slots', () => {
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
    const slots = new Set(names.map((n) => deriveProjectColorSlot(n).bg))
    // Not all identical — bucket distribution worked.
    expect(slots.size).toBeGreaterThanOrEqual(4)
  })
})

describe('PROJECT_COLOR_SLOTS palette', () => {
  it('has exactly 10 slots', () => {
    expect(PROJECT_COLOR_SLOTS.length).toBe(10)
  })
  it('every slot uses a distinct Tailwind color family (no hue collisions)', () => {
    // Parse the `bg-<family>-200` token out of each slot's bg classes.
    const families = PROJECT_COLOR_SLOTS.map((slot) => {
      const match = /bg-([a-z]+)-200\b/.exec(slot.bg)
      if (!match) throw new Error(`slot missing bg-*-200 token: ${slot.bg}`)
      return match[1]
    })
    const uniq = new Set(families)
    expect(uniq.size).toBe(families.length)
  })
})

describe('formatTabLabel', () => {
  it('canonical worktree, single session → abbrev only', () => {
    expect(formatTabLabel('duraclaw', 's1', ['s1'])).toBe('DC')
  })
  it('numeric worktree, single session → abbrev + N', () => {
    expect(formatTabLabel('duraclaw-dev3', 's1', ['s1'])).toBe('DC3')
  })
  it('numeric worktree, multi-session → abbrev + N + letter', () => {
    expect(formatTabLabel('duraclaw-dev3', 's1', ['s1', 's2'])).toBe('DC3a')
    expect(formatTabLabel('duraclaw-dev3', 's2', ['s1', 's2'])).toBe('DC3b')
  })
})

describe('statusRingClass', () => {
  it('maps known statuses to expected ring colors', () => {
    expect(statusRingClass('running')).toContain('green')
    expect(statusRingClass('waiting_gate')).toContain('amber')
    expect(statusRingClass('waiting_input')).toContain('amber')
    expect(statusRingClass('disconnected')).toContain('gray')
    expect(statusRingClass('archived')).toContain('gray')
  })
  it('idle returns a muted ring', () => {
    expect(statusRingClass('idle')).toContain('ring-1')
  })
  it('unknown falls back to muted ring', () => {
    expect(statusRingClass('foo')).toContain('ring-1')
    expect(statusRingClass(undefined)).toContain('ring-1')
  })
})
