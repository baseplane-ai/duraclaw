import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// GH#125 follow-up regression guard.
//
// Tamagui's `styled(View, { ... })` inherits React Native semantics, where
// `View` defaults to `flexDirection: 'column'`. Setting `display: 'flex'`
// or `display: 'inline-flex'` does NOT make children lay out in a row —
// you must declare `flexDirection: 'row'` (or `'column'`) explicitly.
//
// Post-Tamagui-merge (PR #127, GH#125 P1a/P1b) we shipped four shells
// that forgot this and laid out icon+label children vertically:
//
//   - SidebarMenuSubButtonShell   (sidebar ▶ chevron + label + count clip)
//   - SidebarGroupLabelShell      (sidebar group header)
//   - SidebarGroupActionShell     (sidebar group action button)
//   - SidebarMenuActionShell      (sidebar menu row trailing action)
//   - SidebarMenuBadgeShell       (sidebar menu trailing badge)
//   - SidebarMenuSkeletonShell    (sidebar skeleton loader row)
//   - ButtonShell                 (gate Approve/Deny stacked icon+text)
//   - BadgeShell                  (reasoning pill brain-icon + label)
//   - CardFooterShell             (card footer button row)
//
// All have been fixed to declare `flexDirection` explicitly. This test
// guards against regressing — any new `styled(View, { ... })` block that
// declares `display: 'flex' | 'inline-flex'` MUST also declare
// `flexDirection`. Catching it here is much cheaper than a screenshot
// review pass.

const UI_DIR = __dirname

// Extract every `styled(View, { ... })` literal-object block from a
// source file. We only need the top-level styled() call here — the four
// known buggy shells were all top-level declarations.
function extractStyledViewBlocks(source: string): Array<{ name: string; body: string }> {
  const blocks: Array<{ name: string; body: string }> = []
  const re = /const\s+(\w+)\s*=\s*styled\(\s*View\s*,\s*\{/g
  let match: RegExpExecArray | null

  while ((match = re.exec(source)) !== null) {
    const name = match[1]
    const start = match.index + match[0].length - 1 // point at the `{`
    let depth = 0
    let end = start
    for (let i = start; i < source.length; i++) {
      const ch = source[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    blocks.push({ name, body: source.slice(start + 1, end) })
  }

  return blocks
}

describe('styled(View) flex direction guard', () => {
  it('every flex/inline-flex styled(View) shell declares flexDirection explicitly', () => {
    const files = readdirSync(UI_DIR)
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => join(UI_DIR, f))
    const violations: string[] = []

    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const blocks = extractStyledViewBlocks(src)

      for (const block of blocks) {
        const hasFlex = /display:\s*['"](?:inline-)?flex['"]/.test(block.body)
        const hasFlexDirection = /flexDirection:\s*['"](?:row|column)(?:-reverse)?['"]/.test(
          block.body,
        )

        if (hasFlex && !hasFlexDirection) {
          violations.push(`${file}: ${block.name} declares display:flex without flexDirection`)
        }
      }
    }

    expect(
      violations,
      `Tamagui styled(View) shells with display:flex must declare flexDirection ` +
        `(default is 'column' — missing it causes icon+label children to stack ` +
        `vertically). Add flexDirection: 'row' (or 'column') explicitly.\n` +
        violations.join('\n'),
    ).toEqual([])
  })
})
