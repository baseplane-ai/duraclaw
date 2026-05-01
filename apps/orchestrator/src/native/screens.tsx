/**
 * Native screen renderers for the Expo SDK 55 target.
 *
 * Status (GH#157 partial):
 *   - LoginScreen + MaintenanceScreen: real RN reimplementations.
 *     Login is the VP-3 critical path — without it, sign-in
 *     end-to-end can't be tested even though auth-client-expo +
 *     installNativeFetchInterceptor + use-user-stream are wired up
 *     for the Expo target.
 *   - All other screens: still placeholder stubs. Extracting
 *     AgentOrchPage (21KB), ChatThread (54KB), Settings (37KB),
 *     etc. into RN-compatible primitives is multi-day work that
 *     belongs in its own follow-up. Each screen needs its own
 *     conversion of shadcn/ui (Card, Button, Input, Dialog, …),
 *     Tailwind classes, and TanStack Router hooks (Link,
 *     useNavigate, search params) to React Navigation equivalents.
 *     Track in GH#157 §1.
 *
 * Why we don't import the route-file components directly: TanStack
 * Router's `createFileRoute(...)` returns a `Route` object (route
 * config + component), not a bare React component. React Navigation
 * expects a component. Wrapping each TanStack `Route.options.component`
 * works on the web build but pulls TanStack Router internals into the
 * native bundle, and the route components themselves render DOM (`<div>`,
 * `<form>`, `<input>`) — they wouldn't render on RN even if we did.
 */

import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { KanbanBoardNative } from '~/features/kanban/KanbanBoardNative'
import { authClient } from '~/lib/auth-client'

type ScreenProps = { route?: { params?: Record<string, unknown> } }

// ---- Real screens -----------------------------------------------------

/**
 * LoginScreen — RN reimplementation of routes/login.tsx for the Expo
 * native target. Calls `authClient.signIn.email({ email, password })`;
 * on success, the session updates and entry-rn.tsx's `isAuthenticated`
 * gate flips, swapping the root stack from Login → AuthenticatedTabs.
 *
 * Mirrors the web behaviour for the auth-redirect-reason toast: web
 * uses sessionStorage + sonner; native has no sessionStorage and we
 * skip the toast (the redirect path on native is set-and-forget — a
 * 401 surfaces via the next sign-in attempt's error message anyway).
 */
export function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Defensive: surface a typed-but-stale auth client at mount so a
  // missing native auth-client wiring fails loudly instead of silently
  // returning an empty error on first sign-in attempt.
  useEffect(() => {
    if (!authClient?.signIn) {
      setError('Auth client not initialised — restart the app and try again.')
    }
  }, [])

  const onSubmit = async () => {
    if (loading) return
    setError('')
    if (!email || !password) {
      setError('Email and password are required')
      return
    }
    setLoading(true)
    try {
      const { error: authError } = await authClient.signIn.email({ email, password })
      if (authError) {
        setError(authError.message ?? 'Authentication failed')
      }
      // On success, no explicit navigate — the session update flips
      // `isAuthenticated` in entry-rn.tsx and the root stack swaps.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[login-native] signIn threw:', err)
      setError(`Sign-in error: ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={loginStyles.flex}
    >
      <View style={loginStyles.outer}>
        <View style={loginStyles.card}>
          <Text style={loginStyles.eyebrow}>ACCESS</Text>
          <Text style={loginStyles.title}>Sign in</Text>

          <View style={loginStyles.field}>
            <Text style={loginStyles.label}>Email</Text>
            <TextInput
              accessibilityLabel="Email"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              editable={!loading}
              keyboardType="email-address"
              onChangeText={setEmail}
              placeholder="Email"
              style={loginStyles.input}
              testID="login-email"
              textContentType="emailAddress"
              value={email}
            />
          </View>

          <View style={loginStyles.field}>
            <Text style={loginStyles.label}>Password</Text>
            <TextInput
              accessibilityLabel="Password"
              autoCapitalize="none"
              autoComplete="password"
              autoCorrect={false}
              editable={!loading}
              onChangeText={setPassword}
              placeholder="Password"
              secureTextEntry
              style={loginStyles.input}
              testID="login-password"
              textContentType="password"
              value={password}
            />
          </View>

          {error ? (
            <View style={loginStyles.errorBox}>
              <Text style={loginStyles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Pressable
            accessibilityLabel="Sign in"
            accessibilityRole="button"
            disabled={loading}
            onPress={onSubmit}
            style={({ pressed }) => [
              loginStyles.button,
              loading || pressed ? loginStyles.buttonPressed : null,
            ]}
            testID="login-submit"
          >
            {loading ? (
              <ActivityIndicator color="#f8fafc" />
            ) : (
              <Text style={loginStyles.buttonLabel}>Sign In</Text>
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

const loginStyles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#020618' },
  outer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#020919',
    borderColor: 'rgba(255,255,255,0.1)',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 28,
    padding: 24,
    gap: 16,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 2,
    color: '#90a1b9',
  },
  title: { fontSize: 24, fontWeight: '600', color: '#f8fafc' },
  field: { gap: 6 },
  label: { fontSize: 14, fontWeight: '500', color: '#f8fafc' },
  input: {
    minHeight: 44,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: '#f8fafc',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  errorBox: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: 'rgba(255,100,103,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,100,103,0.4)',
  },
  errorText: { color: '#ff6467', fontSize: 14 },
  button: {
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  buttonPressed: { opacity: 0.7 },
  buttonLabel: { color: '#0f172b', fontSize: 14, fontWeight: '600' },
})

/**
 * MaintenanceScreen — surfaced when the orchestrator gates traffic
 * during a migration. Mirrors routes/maintenance.tsx (which renders
 * a centred "Migration in progress" card).
 */
export function MaintenanceScreen() {
  return (
    <View style={maintenanceStyles.outer}>
      <View style={maintenanceStyles.card}>
        <Text style={maintenanceStyles.title}>Migration in progress</Text>
        <Text style={maintenanceStyles.body}>
          We&apos;re upgrading our storage. Back in about 15 minutes.
        </Text>
      </View>
    </View>
  )
}

const maintenanceStyles = StyleSheet.create({
  outer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#020618',
    paddingHorizontal: 32,
  },
  card: { gap: 16, alignItems: 'center', maxWidth: 420 },
  title: { fontSize: 22, fontWeight: '600', color: '#f8fafc' },
  body: { fontSize: 16, color: '#90a1b9', textAlign: 'center' },
})

// ---- Stub screens (GH#157 §1 follow-up) -------------------------------

/**
 * Stub renderer for screens that haven't been extracted yet. Renders
 * a label + (optional) route params + a TODO note pointing at the
 * tracking issue. The navigation graph mounts these so the user can
 * still walk the tab tree.
 */
function Stub({ label, params }: { label: string; params?: Record<string, unknown> }) {
  return (
    <View style={stubStyles.outer}>
      <Text style={stubStyles.label}>{label}</Text>
      {params && Object.keys(params).length > 0 ? (
        <Text style={stubStyles.params}>{JSON.stringify(params)}</Text>
      ) : null}
      <Text style={stubStyles.todo}>Native screen pending — see GH#157 §1.</Text>
    </View>
  )
}

const stubStyles = StyleSheet.create({
  outer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  label: { fontSize: 18, fontWeight: '600' },
  params: { marginTop: 8, opacity: 0.6 },
  todo: { marginTop: 16, opacity: 0.5, fontSize: 12 },
})

export function HomeScreen() {
  return <Stub label="Home" />
}
export function SessionDetailScreen({ route }: ScreenProps) {
  return <Stub label="Session" params={route?.params} />
}
export function ArcDetailScreen({ route }: ScreenProps) {
  return <Stub label="Arc" params={route?.params} />
}
/**
 * BoardScreen wraps the read-only `KanbanBoardNative` (existing — see
 * `~/features/kanban/KanbanBoardNative.tsx`) so the Board tab mounts the
 * real arc-list rendering instead of a stub. Drag-to-advance is still
 * deferred (GH#157 §5, blocked on a native AdvanceConfirmModal).
 */
export function BoardScreen() {
  return <KanbanBoardNative />
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
