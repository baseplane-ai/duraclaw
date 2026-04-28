import { createTamagui, createTokens } from '@tamagui/core'
import { createInterFont } from '@tamagui/font-inter'

const colorTokens = {
  background: '#fafafa',
  foreground: '#0a0a0a',
  primary: '#1a1a2e',
  primaryForeground: '#fafafa',
  secondary: '#f5f5f7',
  secondaryForeground: '#1a1a2e',
  muted: '#f5f5f7',
  mutedForeground: '#71717a',
  accent: '#f5f5f7',
  accentForeground: '#1a1a2e',
  destructive: '#dc2626',
  border: '#e5e5e5',
  input: '#e5e5e5',
  ring: '#a1a1aa',
}

const tokens = createTokens({
  color: colorTokens,
  radius: { 0: 0, 1: 4, 2: 6, 3: 8, 4: 12, 5: 16 },
  space: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, true: 8 },
  size: { 0: 0, 1: 20, 2: 28, 3: 36, 4: 44, 5: 52, true: 36 },
  zIndex: { 0: 0, 1: 100, 2: 200, 3: 300, 4: 400, 5: 500 },
})

const lightTheme = { ...colorTokens }
const darkTheme = {
  ...colorTokens,
  background: '#09090b',
  foreground: '#fafafa',
  card: '#18181b',
  primary: '#e4e4e7',
  primaryForeground: '#1a1a2e',
}

const interFont = createInterFont()

export const tamaguiConfig = createTamagui({
  tokens,
  themes: { light: lightTheme, dark: darkTheme },
  media: { mobile: { maxWidth: 767 } },
  defaultFont: 'inter',
  fonts: { inter: interFont },
})

export type AppConfig = typeof tamaguiConfig
declare module '@tamagui/core' {
  interface TamaguiCustomConfig extends AppConfig {}
}
