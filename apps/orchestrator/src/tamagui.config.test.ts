import { describe, expect, it } from 'vitest'
import { tamaguiConfig } from './tamagui.config'

// GH#125 P1a: minimal sanity test for the Tamagui config — guards against
// token-shape regressions during P1b (compiler enable + sidebar migration)
// and any future theme.css → tamagui.config.ts re-conversion. The 13
// migrated primitives (button/card/input/label/badge/separator/avatar/
// tabs/textarea/table/alert/skeleton/collapsible) all reference these
// token names; renaming or removing one is a silent breakage at render
// time, so we lock the shape here.

describe('tamaguiConfig', () => {
  it('exports a config object', () => {
    expect(tamaguiConfig).toBeDefined()
    expect(typeof tamaguiConfig).toBe('object')
  })

  it('exposes light + dark themes', () => {
    expect(tamaguiConfig.themes).toHaveProperty('light')
    expect(tamaguiConfig.themes).toHaveProperty('dark')
  })

  it('light theme defines the 24 shadcn token aliases consumed by primitives', () => {
    const expectedKeys = [
      'background',
      'foreground',
      'card',
      'cardForeground',
      'popover',
      'popoverForeground',
      'primary',
      'primaryForeground',
      'secondary',
      'secondaryForeground',
      'muted',
      'mutedForeground',
      'accent',
      'accentForeground',
      'destructive',
      'info',
      'infoForeground',
      'warning',
      'warningForeground',
      'success',
      'successForeground',
      'border',
      'input',
      'ring',
    ]
    for (const key of expectedKeys) {
      expect(tamaguiConfig.themes.light, `light theme missing token: ${key}`).toHaveProperty(key)
    }
  })

  it('dark theme defines the same 24 token aliases', () => {
    const lightKeys = Object.keys(tamaguiConfig.themes.light)
    const darkKeys = Object.keys(tamaguiConfig.themes.dark)
    for (const key of lightKeys) {
      expect(darkKeys, `dark theme missing token mirrored from light: ${key}`).toContain(key)
    }
  })

  it('exposes a mobile media query matching the legacy useIsMobile breakpoint', () => {
    // useIsMobile in hooks/use-mobile.tsx uses (max-width: 767px). Tamagui's
    // mobile media must mirror this so consumers using $mobile token-aware
    // styles get the same break point.
    expect(tamaguiConfig.media).toHaveProperty('mobile')
    expect((tamaguiConfig.media as { mobile: { maxWidth: number } }).mobile.maxWidth).toBe(767)
  })

  it('exposes the radius scale referenced by primitives ($sm/$md/$lg/$xl)', () => {
    const radius = tamaguiConfig.tokens.radius as Record<string, unknown>
    expect(radius).toHaveProperty('sm')
    expect(radius).toHaveProperty('md')
    expect(radius).toHaveProperty('lg')
    expect(radius).toHaveProperty('xl')
  })
})
