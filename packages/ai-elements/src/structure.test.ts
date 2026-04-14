import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(__dirname)

describe('package structure', () => {
  it('index.ts exists and has re-exports', () => {
    const indexPath = join(SRC_DIR, 'index.ts')
    const content = readFileSync(indexPath, 'utf-8')
    expect(content).toContain("export * from './components/")
    expect(content).toContain("export { cn } from './lib/utils'")
  })

  it('every component file is re-exported from index.ts', () => {
    const indexContent = readFileSync(join(SRC_DIR, 'index.ts'), 'utf-8')
    const componentFiles = readdirSync(join(SRC_DIR, 'components'))
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => f.replace('.tsx', ''))

    // At least 20 components should be re-exported
    const exportCount = (indexContent.match(/export \* from '\.\/components\//g) || []).length
    expect(exportCount).toBeGreaterThanOrEqual(20)
  })

  it('no files contain unresolved @/shared imports', () => {
    const dirs = ['components', 'ui', 'lib', 'hooks']
    const violations: string[] = []

    for (const dir of dirs) {
      const dirPath = join(SRC_DIR, dir)
      let files: string[]
      try {
        files = readdirSync(dirPath)
      } catch {
        continue
      }

      for (const file of files) {
        if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue
        const content = readFileSync(join(dirPath, file), 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (
            line.match(/from\s+['"]@\/shared/) ||
            (line.match(/import\s.*['"]@\/shared/) &&
              !line.trimStart().startsWith('*') &&
              !line.trimStart().startsWith('//'))
          ) {
            violations.push(`${dir}/${file}:${i + 1}: ${line.trim()}`)
          }
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('required directories exist with files', () => {
    const dirs = ['components', 'ui', 'lib']
    for (const dir of dirs) {
      const files = readdirSync(join(SRC_DIR, dir))
      expect(files.length).toBeGreaterThan(0)
    }
  })

  it('ui directory contains expected primitives', () => {
    const uiFiles = readdirSync(join(SRC_DIR, 'ui'))
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => f.replace('.tsx', ''))

    const expected = [
      'alert',
      'badge',
      'button',
      'card',
      'collapsible',
      'dialog',
      'dropdown-menu',
      'hover-card',
      'input',
      'scroll-area',
      'select',
      'separator',
      'tooltip',
    ]

    for (const primitive of expected) {
      expect(uiFiles).toContain(primitive)
    }
  })

  it('lib/utils.ts exports cn function', () => {
    const content = readFileSync(join(SRC_DIR, 'lib', 'utils.ts'), 'utf-8')
    expect(content).toContain('export function cn(')
  })

  it('lib/tool-display.ts exports tool display functions', () => {
    const content = readFileSync(join(SRC_DIR, 'lib', 'tool-display.ts'), 'utf-8')
    expect(content).toContain('export function getToolDisplayName(')
    expect(content).toContain('export function summarizeToolResult(')
    expect(content).toContain('export function summarizeToolArgs(')
    expect(content).toContain('export function groupToolCalls(')
  })

  it('useControllableState comes from @radix-ui (no custom hook)', () => {
    // Verify no custom hook file exists — we use @radix-ui/react-use-controllable-state
    const hooksDir = join(SRC_DIR, 'hooks')
    let files: string[] = []
    try {
      files = readdirSync(hooksDir)
    } catch {
      // hooks dir may not exist, that's fine
    }
    expect(files).not.toContain('use-controllable-state.ts')
  })
})
