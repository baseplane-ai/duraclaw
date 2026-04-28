import { createTamagui, createTokens } from '@tamagui/core'
import { createInterFont } from '@tamagui/font-inter'

// Theme tokens converted from apps/orchestrator/src/styles/theme.css OKLch
// values via oklch->sRGB. The spec's hello-world uses View, not Stack —
// @tamagui/core@2.0.0-rc.41 does not export Stack from this entry.
//
// Out-of-gamut OKLch values (light.destructive, light.warning,
// light.warningForeground, light.success, dark.destructive, dark.info,
// dark.warningForeground) were clamped to sRGB during conversion. P1b
// will revisit color fidelity (Display-P3 / wide-gamut path).

const lightTheme = {
  background: '#ffffff',
  foreground: '#020618',
  card: '#ffffff',
  cardForeground: '#020618',
  popover: '#ffffff',
  popoverForeground: '#020618',
  primary: '#0f172b',
  primaryForeground: '#f8fafc',
  secondary: '#f1f5f9',
  secondaryForeground: '#0f172b',
  muted: '#f1f5f9',
  mutedForeground: '#62748e',
  accent: '#f1f5f9',
  accentForeground: '#0f172b',
  destructive: '#e7000b',
  info: '#2377fd',
  infoForeground: '#f8fafc',
  warning: '#e49000',
  warningForeground: '#231200',
  success: '#009b53',
  successForeground: '#f8fafc',
  border: '#e2e8f0',
  input: '#e2e8f0',
  ring: '#90a1b9',
}

const darkTheme = {
  background: '#020618',
  foreground: '#f8fafc',
  card: '#020919',
  cardForeground: '#f8fafc',
  popover: '#0f172b',
  popoverForeground: '#f8fafc',
  primary: '#e2e8f0',
  primaryForeground: '#0f172b',
  secondary: '#1d293d',
  secondaryForeground: '#f8fafc',
  muted: '#1d293d',
  mutedForeground: '#90a1b9',
  accent: '#1d293d',
  accentForeground: '#f8fafc',
  destructive: '#ff6467',
  info: '#4c9fff',
  infoForeground: '#f8fafc',
  warning: '#f0b135',
  warningForeground: '#231200',
  success: '#2fc183',
  successForeground: '#040e08',
  // alpha overrides per .dark in theme.css (oklch(1 0 0 / 10%) etc.)
  border: 'rgba(255,255,255,0.1)',
  input: 'rgba(255,255,255,0.15)',
  ring: '#6a7282',
}

const tokens = createTokens({
  // Tamagui's createTokens requires color tokens at the tokens level too
  // (themes pull from these by name). Use the light theme as the canonical
  // token set; dark overrides via theme switch.
  color: lightTheme,
  // Tailwind --radius is 0.625rem = 10px; sm=-4, md=-2, lg=0, xl=+4
  radius: { 0: 0, sm: 6, md: 8, lg: 10, xl: 14, true: 8 },
  space: {
    0: 0,
    1: 4,
    2: 8,
    3: 12,
    4: 16,
    5: 24,
    6: 32,
    7: 48,
    8: 64,
    true: 8,
    // GH#125 P1b — sidebar widths (replaces --sidebar-width / --sidebar-width-icon
    // CSS-var arbitrary-calc patterns from the pre-Tamagui sidebar). 16rem,
    // 18rem, 3rem in pixels at the default 16px root font.
    sidebarWidth: 256,
    sidebarWidthMobile: 288,
    sidebarWidthIcon: 48,
  },
  size: { 0: 0, 1: 20, 2: 28, 3: 36, 4: 44, 5: 52, 6: 64, 7: 80, true: 36 },
  zIndex: { 0: 0, 1: 100, 2: 200, 3: 300, 4: 400, 5: 500 },
})

const interFont = createInterFont()

export const tamaguiConfig = createTamagui({
  tokens,
  themes: { light: lightTheme, dark: darkTheme },
  // matches existing useIsMobile breakpoint (max-width: 767)
  media: { mobile: { maxWidth: 767 } },
  defaultFont: 'inter',
  fonts: { inter: interFont },
})

export type AppConfig = typeof tamaguiConfig
declare module '@tamagui/core' {
  interface TamaguiCustomConfig extends AppConfig {}
}
