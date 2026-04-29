import { describe, expect, it } from 'vitest'
import {
  deriveProjectAbbrev,
  deriveProjectColorSlot,
  deriveRepoBase,
  deriveSessionSuffix,
  formatTabLabel,
  isValidAbbrevOverride,
  isValidColorSlotOverride,
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

  // GH#84: per-project abbrev override.
  it('GH#84: valid abbrev override replaces the derived abbrev', () => {
    // Auto-derive would be "DC"; the override wins.
    expect(formatTabLabel('duraclaw', 's1', ['s1'], 'DZ')).toBe('DZ')
    // Worktree-N segment still appended after the override.
    expect(formatTabLabel('duraclaw-dev3', 's1', ['s1'], 'DZ')).toBe('DZ3')
    // Session suffix still appended on multi-session worktree.
    expect(formatTabLabel('duraclaw-dev3', 's2', ['s1', 's2'], 'DZ')).toBe('DZ3b')
  })
  it('GH#84: 1-char abbrev override is allowed', () => {
    expect(formatTabLabel('duraclaw', 's1', ['s1'], 'X')).toBe('X')
  })
  it('GH#84: invalid abbrev override silently falls back to derivation', () => {
    expect(formatTabLabel('duraclaw', 's1', ['s1'], 'lower')).toBe('DC')
    expect(formatTabLabel('duraclaw', 's1', ['s1'], '')).toBe('DC')
    expect(formatTabLabel('duraclaw', 's1', ['s1'], 'TOO_LONG')).toBe('DC')
    expect(formatTabLabel('duraclaw', 's1', ['s1'], 'ab')).toBe('DC') // lowercase rejected
    expect(formatTabLabel('duraclaw', 's1', ['s1'], 'a!')).toBe('DC')
    // Null / undefined treated as no override.
    expect(formatTabLabel('duraclaw', 's1', ['s1'], null)).toBe('DC')
    expect(formatTabLabel('duraclaw', 's1', ['s1'], undefined)).toBe('DC')
  })
})

describe('GH#84: deriveProjectColorSlot override', () => {
  it('valid in-range override returns that exact slot', () => {
    expect(deriveProjectColorSlot('duraclaw', 0)).toEqual(PROJECT_COLOR_SLOTS[0])
    expect(deriveProjectColorSlot('duraclaw', 5)).toEqual(PROJECT_COLOR_SLOTS[5])
    expect(deriveProjectColorSlot('duraclaw', PROJECT_COLOR_SLOTS.length - 1)).toEqual(
      PROJECT_COLOR_SLOTS[PROJECT_COLOR_SLOTS.length - 1],
    )
  })
  it('override beats hash derivation even when keys would otherwise differ', () => {
    expect(deriveProjectColorSlot('duraclaw', 3)).toEqual(deriveProjectColorSlot('kata', 3))
  })
  it('override applies even when key is null/empty (overrides the unassigned fallback)', () => {
    expect(deriveProjectColorSlot('', 2)).toEqual(PROJECT_COLOR_SLOTS[2])
    expect(deriveProjectColorSlot(null, 4)).toEqual(PROJECT_COLOR_SLOTS[4])
  })
  it('out-of-range override silently falls through to hash derivation', () => {
    const fallback = deriveProjectColorSlot('duraclaw')
    expect(deriveProjectColorSlot('duraclaw', -1)).toEqual(fallback)
    expect(deriveProjectColorSlot('duraclaw', PROJECT_COLOR_SLOTS.length)).toEqual(fallback)
    expect(deriveProjectColorSlot('duraclaw', 999)).toEqual(fallback)
    expect(deriveProjectColorSlot('duraclaw', 1.5)).toEqual(fallback)
    expect(deriveProjectColorSlot('duraclaw', Number.NaN)).toEqual(fallback)
  })
  it('null/undefined override is treated as no override', () => {
    expect(deriveProjectColorSlot('duraclaw', null)).toEqual(deriveProjectColorSlot('duraclaw'))
    expect(deriveProjectColorSlot('duraclaw', undefined)).toEqual(
      deriveProjectColorSlot('duraclaw'),
    )
  })
})

describe('GH#84: validators', () => {
  describe('isValidAbbrevOverride', () => {
    it('accepts 1–2 uppercase alphanumerics', () => {
      expect(isValidAbbrevOverride('A')).toBe(true)
      expect(isValidAbbrevOverride('AB')).toBe(true)
      expect(isValidAbbrevOverride('A1')).toBe(true)
      expect(isValidAbbrevOverride('99')).toBe(true)
      expect(isValidAbbrevOverride('XY')).toBe(true)
    })
    it('rejects lowercase, empty, oversize, punctuation', () => {
      expect(isValidAbbrevOverride('')).toBe(false)
      expect(isValidAbbrevOverride('a')).toBe(false)
      expect(isValidAbbrevOverride('Ab')).toBe(false)
      expect(isValidAbbrevOverride('ABC')).toBe(false)
      expect(isValidAbbrevOverride('A!')).toBe(false)
      expect(isValidAbbrevOverride(' A')).toBe(false)
      expect(isValidAbbrevOverride('A ')).toBe(false)
    })
  })
  describe('isValidColorSlotOverride', () => {
    it('accepts integers in [0, slot count)', () => {
      for (let i = 0; i < PROJECT_COLOR_SLOTS.length; i++) {
        expect(isValidColorSlotOverride(i)).toBe(true)
      }
    })
    it('rejects out-of-range, non-integer, non-number', () => {
      expect(isValidColorSlotOverride(-1)).toBe(false)
      expect(isValidColorSlotOverride(PROJECT_COLOR_SLOTS.length)).toBe(false)
      expect(isValidColorSlotOverride(1.5)).toBe(false)
      expect(isValidColorSlotOverride(Number.NaN)).toBe(false)
      expect(isValidColorSlotOverride('0')).toBe(false)
      expect(isValidColorSlotOverride(null)).toBe(false)
      expect(isValidColorSlotOverride(undefined)).toBe(false)
    })
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
