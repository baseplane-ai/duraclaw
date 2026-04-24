/**
 * project-display — pure helpers for the dense, project-grouped tab design.
 *
 * Derives a stable per-project `abbrev` + `color` slot and a per-session
 * suffix (worktree N + a/b/c disambiguator) with no user configuration
 * required. This is the task-scope stopgap for the tab redesign; a
 * follow-up issue adds user-editable abbrev/color via project settings.
 *
 * All exports are pure functions — safe to unit-test and call from render.
 */

/**
 * Curated 10-slot chroma-distinct palette for project fills. All slots use
 * distinct Tailwind color families (no two greys adjacent, no two slots
 * sharing a hue family) so any two projects differ in hue, not just
 * luminance. `dark:bg-*-800` / `dark:text-*-50` give saturated fills with
 * legible labels on dark mode.
 */
export const PROJECT_COLOR_SLOTS = [
  { bg: 'bg-sky-200 dark:bg-sky-800', text: 'text-sky-900 dark:text-sky-50' },
  { bg: 'bg-rose-200 dark:bg-rose-800', text: 'text-rose-900 dark:text-rose-50' },
  { bg: 'bg-emerald-200 dark:bg-emerald-800', text: 'text-emerald-900 dark:text-emerald-50' },
  { bg: 'bg-amber-200 dark:bg-amber-800', text: 'text-amber-900 dark:text-amber-50' },
  { bg: 'bg-violet-200 dark:bg-violet-800', text: 'text-violet-900 dark:text-violet-50' },
  { bg: 'bg-fuchsia-200 dark:bg-fuchsia-800', text: 'text-fuchsia-900 dark:text-fuchsia-50' },
  { bg: 'bg-teal-200 dark:bg-teal-800', text: 'text-teal-900 dark:text-teal-50' },
  { bg: 'bg-orange-200 dark:bg-orange-800', text: 'text-orange-900 dark:text-orange-50' },
  { bg: 'bg-indigo-200 dark:bg-indigo-800', text: 'text-indigo-900 dark:text-indigo-50' },
  { bg: 'bg-lime-200 dark:bg-lime-800', text: 'text-lime-900 dark:text-lime-50' },
] as const

export type ProjectColorSlot = { readonly bg: string; readonly text: string }

/**
 * Neutral fallback slot for sessions with no project-color key (null/empty).
 * Deliberately outline-only so it visually reads as "unassigned" rather
 * than colliding with any hashable project slot.
 */
export const UNASSIGNED_COLOR_SLOT: ProjectColorSlot = {
  bg: 'bg-transparent border border-dashed border-muted-foreground/40',
  text: 'text-muted-foreground',
}

/** FNV-1a 32-bit hash — small, stable, non-crypto. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Stable color slot for a project, keyed by any string that's shared
 * across its worktrees (typically `repo_origin`, falling back to the repo
 * base name). Same key → same slot across renders and sessions. Null /
 * empty keys return the dedicated `UNASSIGNED_COLOR_SLOT` so they don't
 * collide with any hashable project slot.
 */
export function deriveProjectColorSlot(key: string | null | undefined): ProjectColorSlot {
  if (!key) return UNASSIGNED_COLOR_SLOT
  return PROJECT_COLOR_SLOTS[fnv1a(key) % PROJECT_COLOR_SLOTS.length]
}

/**
 * Strip a conventional worktree suffix (`-dev3`, `-42`, `-wip2`) from a
 * project name to get the canonical repo base name.
 *
 *   "duraclaw"           → "duraclaw"
 *   "duraclaw-dev3"      → "duraclaw"
 *   "project-wip"        → "project"
 *
 * Only strips the common conventions; anything else is returned as-is.
 */
export function deriveRepoBase(projectName: string): string {
  if (!projectName) return ''
  return projectName.replace(/-(?:dev\d+|\d+|wip\d*)$/i, '')
}

/**
 * 2-char project abbreviation derived from the project name.
 *
 *   "duraclaw"           → "DC"   (first + first consonant)
 *   "my-project"         → "MP"   (two word initials)
 *   "agent_gateway"      → "AG"   (two word initials)
 *   "foo"                → "FO"   (consonant search failed, second char)
 *   "x"                  → "X"    (single-char fallback)
 *   ""                   → "--"   (empty fallback)
 */
export function deriveProjectAbbrev(name: string): string {
  if (!name) return '--'
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  const word = parts[0] ?? name
  const first = (word[0] ?? '').toUpperCase()
  const rest = word.slice(1)
  // Prefer the consonant that opens a new syllable further into the word
  // — that's the one a human picks for a mnemonic ("duraclaw" → DC, not
  // DR). The regex skips past a leading vowel and any intervening
  // consonants to find a *later* vowel → consonant transition. Falls back
  // to the second raw char when the word is all-vowel or has no later
  // syllable-opener ("foo" → FO, "agent" → AG).
  const postVowel = /[aeiou].*?[aeiou]+([bcdfghjklmnpqrstvwxyz])/i.exec(rest)
  const second = (postVowel ? postVowel[1] : (rest[0] ?? '')).toUpperCase()
  const abbr = (first + second).slice(0, 2)
  return abbr || name.slice(0, 2).toUpperCase() || '--'
}

/**
 * Parse the worktree suffix from a project name. Returns the trailing
 * numeric/label segment after the repo base, or '' for the canonical
 * worktree.
 *
 *   parseWorktreeSuffix("duraclaw")              → ""
 *   parseWorktreeSuffix("duraclaw-dev1")         → "1"
 *   parseWorktreeSuffix("duraclaw-dev3")         → "3"
 *   parseWorktreeSuffix("duraclaw-wip")          → "wip"
 *   parseWorktreeSuffix("foo-bar", "baz")        → ""   (no match)
 *
 * When `repoName` is omitted, the repo base is derived via `deriveRepoBase`.
 */
export function parseWorktreeSuffix(projectName: string, repoName?: string): string {
  if (!projectName) return ''
  const base = repoName ?? deriveRepoBase(projectName)
  if (!base || projectName === base) return ''
  const prefix = `${base}-`
  if (!projectName.startsWith(prefix)) return ''
  const rest = projectName.slice(prefix.length)
  // Collapse the common `foo-dev3` convention down to just `3`.
  const stripped = rest.replace(/^dev/i, '')
  return stripped || rest
}

/**
 * Stable `a/b/c/...` suffix for sessions sharing a worktree. Returns '' when
 * the session is the only one in its worktree.
 *
 * `siblingIds` must be sorted deterministically (caller's responsibility —
 * sort by createdAt, id, or any other stable key) so the letter stays
 * stable across renders.
 *
 * Beyond index 25, wraps into `z2`, `z3`, ... — not pretty, but unique
 * and the design says multi-session-in-one-worktree is rare.
 */
export function deriveSessionSuffix(sessionId: string, siblingIds: readonly string[]): string {
  if (siblingIds.length <= 1) return ''
  const i = siblingIds.indexOf(sessionId)
  if (i < 0) return ''
  if (i < 26) return String.fromCharCode(97 + i)
  return `z${String(i - 24)}`
}

/**
 * Compose the full tab label for a session:
 *   `${abbrev}${worktreeN}${sessionSuffix}`
 *
 *   "DC"                  canonical worktree, single session
 *   "DC3"                 duraclaw-dev3, single session
 *   "DC3a" / "DC3b"       duraclaw-dev3, multi-session
 */
export function formatTabLabel(
  projectName: string,
  sessionId: string,
  siblingIds: readonly string[],
): string {
  const base = deriveRepoBase(projectName)
  const abbrev = deriveProjectAbbrev(base)
  const worktreeN = parseWorktreeSuffix(projectName, base)
  const suffix = deriveSessionSuffix(sessionId, siblingIds)
  return `${abbrev}${worktreeN}${suffix}`
}

/**
 * Tailwind ring class for the tab outline, derived from session status.
 * Mirrors the `DisplayState.color` semantic palette in display-state.ts
 * so tab / sidebar / status-bar all agree on what each status looks like.
 */
export function statusRingClass(status: string | undefined): string {
  switch (status) {
    case 'running':
      return 'ring-2 ring-green-500'
    case 'waiting_gate':
    case 'waiting_input':
    case 'waiting_permission':
      return 'ring-2 ring-amber-500'
    case 'disconnected':
      return 'ring-2 ring-gray-400'
    case 'archived':
      return 'ring-1 ring-gray-400 opacity-60'
    case 'idle':
      return 'ring-1 ring-gray-400/60 dark:ring-gray-500/60'
    default:
      return 'ring-1 ring-gray-400/60 dark:ring-gray-500/60'
  }
}
