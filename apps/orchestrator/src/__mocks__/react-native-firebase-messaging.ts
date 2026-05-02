// Vitest stub for `@react-native-firebase/messaging`. The package only
// resolves on the Expo shell — under vite/vitest it's not in the
// orchestrator's dependency tree and the dynamic-import in
// `use-push-subscription-native.ts` fails at import-analysis time.
// Aliased in vitest.config.ts.
const messaging = () => ({
  requestPermission: async () => 0,
  getToken: async () => '',
  onTokenRefresh: () => () => {},
})
export default messaging
