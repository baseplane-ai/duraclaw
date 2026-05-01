/**
 * Placeholder screen components for the Expo SDK 55 native target.
 *
 * Each export here is a *stub* — it renders a label and (for screens
 * that have an existing TanStack Router web counterpart) lazy-loads
 * the same React component from the route file via dynamic import.
 *
 * The follow-up cleanup work (P3.3+ / post-merge) extracts the
 * non-route-tree-bound screen rendering from `apps/orchestrator/src/routes/**`
 * into per-feature folders under `~/features/<feature>/...`. Until then,
 * native nav can still mount these stubs and route around the app —
 * navigation graph is real even if the leaf renderers are placeholders.
 *
 * Why stubs and not direct imports of the route files: TanStack
 * Router's `createFileRoute(...)` returns a `Route` object (route
 * config + component), not a bare React component. React Navigation
 * expects a component. Wrapping each TanStack `Route.options.component`
 * works on the web build but pulls TanStack Router internals into the
 * native bundle, which we don't want.
 */

import { Text, View } from 'react-native'

type ScreenProps = { route?: { params?: Record<string, unknown> } }

function Stub({ label, params }: { label: string; params?: Record<string, unknown> }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <Text style={{ fontSize: 18, fontWeight: '600' }}>{label}</Text>
      {params && Object.keys(params).length > 0 ? (
        <Text style={{ marginTop: 8, opacity: 0.6 }}>{JSON.stringify(params)}</Text>
      ) : null}
      <Text style={{ marginTop: 16, opacity: 0.5, fontSize: 12 }}>
        Native screen pending — see GH#132 P3.3 follow-up.
      </Text>
    </View>
  )
}

export function LoginScreen() {
  return <Stub label="Login" />
}
export function MaintenanceScreen() {
  return <Stub label="Maintenance" />
}
export function HomeScreen() {
  return <Stub label="Home" />
}
export function SessionDetailScreen({ route }: ScreenProps) {
  return <Stub label="Session" params={route?.params} />
}
export function ArcDetailScreen({ route }: ScreenProps) {
  return <Stub label="Arc" params={route?.params} />
}
export function BoardScreen() {
  return <Stub label="Board" />
}
export function ProjectsScreen() {
  return <Stub label="Projects" />
}
export function ProjectDocsScreen({ route }: ScreenProps) {
  return <Stub label="Project Docs" params={route?.params} />
}
export function DeploysScreen() {
  return <Stub label="Deploys" />
}
export function SettingsScreen() {
  return <Stub label="Settings" />
}
export function SettingsTestScreen() {
  return <Stub label="Settings · Test" />
}
export function AdminUsersScreen() {
  return <Stub label="Admin · Users" />
}
export function AdminCodexModelsScreen() {
  return <Stub label="Admin · Codex Models" />
}
export function AdminGeminiModelsScreen() {
  return <Stub label="Admin · Gemini Models" />
}
