// Vitest stub for `@capacitor/push-notifications`. The real package is
// resolvable in the orchestrator dep tree, but tests that fork off the
// platform-routing in `use-push-subscription.ts` need a default no-op
// stub so the static import-analysis succeeds even when the test file
// doesn't supply its own `vi.mock(...)`. Aliased in vitest.config.ts.
export const PushNotifications = {
  requestPermissions: async () => ({ receive: 'prompt' }),
  checkPermissions: async () => ({ receive: 'prompt' }),
  register: async () => {},
  addListener: async () => ({ remove: () => {} }),
}
