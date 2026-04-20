import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.baseplane.duraclaw',
  appName: 'Duraclaw',
  webDir: '../orchestrator/dist/client',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    CapacitorUpdater: {
      autoUpdate: false,
      resetWhenUpdate: false,
    },
  },
}

export default config
