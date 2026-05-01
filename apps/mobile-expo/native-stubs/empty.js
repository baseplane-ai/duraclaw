// Stub for Capacitor-only modules that the Expo APK never executes
// at runtime. The orchestrator's db-instance.ts and platform.ts have
// isExpoNative()-first branches that return before reaching the
// Capacitor fallbacks, but Metro statically bundles both branches.
// See apps/mobile-expo/metro.config.js for the alias mapping.
//
// Exporting `default = {}` plus common named accessors so callers
// either dynamic-import-and-destructure or named-import shapes
// don't crash at module-eval time. They never get called because
// the surrounding branch is unreachable on Platform.OS !== 'web'.
module.exports = new Proxy(
  {},
  {
    get() {
      return () => {
        throw new Error(
          '[mobile-expo native-stubs] Capacitor-only API called from Expo runtime. ' +
            'This indicates a Platform.OS branch is wrong; check db-instance.ts / platform.ts.',
        )
      }
    },
  },
)
