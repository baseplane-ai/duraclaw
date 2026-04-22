import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.baseplane.duraclaw',
  appName: 'Duraclaw',
  webDir: '../orchestrator/dist/client',
  server: {
    androidScheme: 'https',
  },
  android: {
    // Release APKs default to `debug` which suppresses WebView console.*
    // output. Keep it on so `adb logcat -s Capacitor/Console:V` surfaces
    // [cm], [ws:*], and [cm-lifecycle] lines from signed builds.
    loggingBehavior: 'production',
  },
  plugins: {
    CapacitorUpdater: {
      autoUpdate: false,
      resetWhenUpdate: false,
    },
  },
}

export default config
