/**
 * Native screen renderers for the Expo SDK 55 target (GH#157 §1).
 *
 * Strategy: minimum-viable native versions that consume the same
 * data hooks (`useLiveQuery` over `*Collection`, `useSession()`, etc.)
 * the web routes use, but render with pure RN primitives instead of
 * shadcn/ui + Tailwind. We don't try to be pixel-faithful — the goal
 * is "every route navigates to something real and shows the user
 * recognisable data", not "shadcn-quality on mobile".
 *
 * Why we don't import the route-file components directly: TanStack
 * Router's `createFileRoute(...)` returns a `Route` object (config +
 * component), not a bare React component. React Navigation expects a
 * component. Even if we unwrapped Route.options.component, the route
 * components render DOM (`<div>`, `<form>`, `<input>`) — they
 * wouldn't render on RN even after the unwrap.
 */

import type { ProjectInfo, SessionSummary } from '@duraclaw/shared-types'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { Route as NavRoute } from '@react-navigation/native'
import { useNavigation } from '@react-navigation/native'
import { useLiveQuery } from '@tanstack/react-db'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { arcsCollection } from '~/db/arcs-collection'
import { createMessagesCollection } from '~/db/messages-collection'
import { projectsCollection } from '~/db/projects-collection'
import { sessionsCollection } from '~/db/sessions-collection'
import { KanbanBoardNative } from '~/features/kanban/KanbanBoardNative'
import { authClient, signOut, useSession } from '~/lib/auth-client'
import { apiUrl } from '~/lib/platform'
import type { ArcSummary } from '~/lib/types'

type ScreenProps<TParams = Record<string, unknown>> = {
  route?: { params?: TParams; name?: string } & NavRoute<string>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  navigation?: any
}

// ---- Shared style tokens ----------------------------------------------

const palette = {
  bg: '#020618',
  surface: '#020919',
  surfaceAlt: 'rgba(255,255,255,0.04)',
  border: 'rgba(255,255,255,0.1)',
  borderStrong: 'rgba(255,255,255,0.18)',
  text: '#f8fafc',
  textMuted: '#90a1b9',
  textDim: '#62748e',
  primary: '#e2e8f0',
  primaryText: '#0f172b',
  destructive: '#ff6467',
  destructiveBg: 'rgba(255,100,103,0.12)',
  success: '#2fc183',
  warning: '#f0b135',
  info: '#4c9fff',
} as const

const text = StyleSheet.create({
  h1: { fontSize: 24, fontWeight: '700', color: palette.text },
  h2: { fontSize: 18, fontWeight: '600', color: palette.text },
  h3: { fontSize: 16, fontWeight: '600', color: palette.text },
  body: { fontSize: 14, color: palette.text },
  muted: { fontSize: 14, color: palette.textMuted },
  small: { fontSize: 12, color: palette.textDim },
  eyebrow: { fontSize: 12, fontWeight: '600', letterSpacing: 2, color: palette.textMuted },
})

const layout = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg },
  pad: { padding: 16 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
})

const card = StyleSheet.create({
  base: {
    backgroundColor: palette.surface,
    borderColor: palette.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 16,
    gap: 8,
    marginBottom: 12,
  },
  pressed: { opacity: 0.6 },
})

const button = StyleSheet.create({
  primary: {
    backgroundColor: palette.primary,
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  primaryLabel: { color: palette.primaryText, fontSize: 14, fontWeight: '600' },
  secondary: {
    backgroundColor: palette.surfaceAlt,
    borderColor: palette.borderStrong,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  secondaryLabel: { color: palette.text, fontSize: 14, fontWeight: '500' },
  destructive: {
    backgroundColor: palette.destructiveBg,
    borderColor: palette.destructive,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  destructiveLabel: { color: palette.destructive, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.7 },
})

// ---- Helpers ----------------------------------------------------------

function formatRelativePast(iso: string | null | undefined): string | null {
  if (!iso) return null
  const target = new Date(iso).getTime()
  if (Number.isNaN(target)) return null
  const deltaMs = Date.now() - target
  if (deltaMs < 0) return 'just now'
  const mins = Math.round(deltaMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return `${days}d ago`
}

function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={pageHeaderStyles.outer}>
      <Text style={text.h1}>{title}</Text>
      {subtitle ? <Text style={text.muted}>{subtitle}</Text> : null}
    </View>
  )
}

const pageHeaderStyles = StyleSheet.create({
  outer: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, gap: 4 },
})

function EmptyState({ message }: { message: string }) {
  return (
    <View style={layout.centered}>
      <Text style={text.muted}>{message}</Text>
    </View>
  )
}

function LoadingState() {
  return (
    <View style={layout.centered}>
      <ActivityIndicator color={palette.text} />
    </View>
  )
}

// ---- Login + Maintenance ----------------------------------------------

/**
 * LoginScreen — RN reimplementation of routes/login.tsx for the Expo
 * native target. Calls `authClient.signIn.email({ email, password })`;
 * on success, the session updates and entry-rn.tsx's `isAuthenticated`
 * gate flips, swapping the root stack from Login → AuthenticatedTabs.
 */
export function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

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
      // No explicit navigate — entry-rn.tsx's `isAuthenticated` gate
      // swaps the root stack on session update.
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
      style={layout.page}
    >
      <View style={layout.centered}>
        <View style={loginStyles.card}>
          <Text style={text.eyebrow}>ACCESS</Text>
          <Text style={text.h1}>Sign in</Text>

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
              placeholderTextColor={palette.textDim}
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
              placeholderTextColor={palette.textDim}
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
            style={({ pressed }) => [button.primary, loading || pressed ? button.pressed : null]}
            testID="login-submit"
          >
            {loading ? (
              <ActivityIndicator color={palette.primaryText} />
            ) : (
              <Text style={button.primaryLabel}>Sign In</Text>
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

const loginStyles = StyleSheet.create({
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: palette.surface,
    borderColor: palette.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 28,
    padding: 24,
    gap: 16,
  },
  field: { gap: 6 },
  label: { fontSize: 14, fontWeight: '500', color: palette.text },
  input: {
    minHeight: 44,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: palette.text,
    backgroundColor: palette.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.borderStrong,
  },
  errorBox: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: palette.destructiveBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.destructive,
  },
  errorText: { color: palette.destructive, fontSize: 14 },
})

export function MaintenanceScreen() {
  return (
    <View style={[layout.page, layout.centered]}>
      <View style={{ gap: 16, alignItems: 'center', maxWidth: 420 }}>
        <Text style={text.h1}>Migration in progress</Text>
        <Text style={[text.body, { textAlign: 'center', color: palette.textMuted }]}>
          We&apos;re upgrading our storage. Back in about 15 minutes.
        </Text>
      </View>
    </View>
  )
}

// ---- Home (session list) ----------------------------------------------

/**
 * HomeScreen — RN reimplementation of the dashboard route
 * (routes/_authenticated/index.tsx → AgentOrchPage). The web version
 * is a 3-column tab/picker IDE; on mobile we render a simple
 * scrollable session list and tap-to-open. Navigates to
 * SessionDetail with `{id}` on tap.
 *
 * Data: `sessionsCollection` live query, sorted by `updatedAt`
 * (newest first), filters out archived sessions to match web's
 * default visibility.
 */
export function HomeScreen({ navigation }: ScreenProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery(sessionsCollection as any)

  const sessions = useMemo(() => {
    if (!data) return [] as SessionSummary[]
    return [...(data as SessionSummary[])]
      .filter((s) => !s.archived)
      .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime())
  }, [data])

  if (isLoading && sessions.length === 0) return <LoadingState />

  return (
    <View style={layout.page}>
      <PageHeader
        title="Sessions"
        subtitle={sessions.length > 0 ? `${sessions.length} active` : undefined}
      />
      {sessions.length === 0 ? (
        <EmptyState message="No active sessions. Spawn one from the web app." />
      ) : (
        <FlatList
          contentContainerStyle={layout.pad}
          data={sessions}
          keyExtractor={(s) => s.id}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation?.navigate('SessionDetail', { id: item.id })}
              style={({ pressed }) => [card.base, pressed ? card.pressed : null]}
            >
              <Text style={text.h3} numberOfLines={1}>
                {item.title || item.prompt || `Session ${item.id.slice(0, 8)}`}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <StatusPill status={item.status} />
                <Text style={text.small}>{item.project}</Text>
                {item.lastActivity ? (
                  <Text style={text.small}>· {formatRelativePast(item.lastActivity)}</Text>
                ) : null}
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  )
}

function StatusPill({ status }: { status: string | null | undefined }) {
  const tone = (() => {
    switch (status) {
      case 'running':
        return { bg: 'rgba(76,159,255,0.15)', fg: palette.info }
      case 'completed':
      case 'idle':
        return { bg: 'rgba(47,193,131,0.15)', fg: palette.success }
      case 'error':
      case 'failed':
        return { bg: palette.destructiveBg, fg: palette.destructive }
      case 'waiting_input':
      case 'waiting_permission':
      case 'waiting_gate':
        return { bg: 'rgba(240,177,53,0.15)', fg: palette.warning }
      default:
        return { bg: palette.surfaceAlt, fg: palette.textMuted }
    }
  })()
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: tone.bg,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: '600', color: tone.fg }}>{status ?? 'unknown'}</Text>
    </View>
  )
}

// ---- Session detail (read-only message tail) --------------------------

/**
 * SessionDetailScreen — read-only tail of a session's messages.
 * The full ChatThread (54KB, with markdown / tool-result rendering /
 * branching / inline images / kata gate UI / etc.) is way out of
 * scope for an RN port. This native version surfaces a chronological
 * list of {role, text} pairs so the user can see what's happening
 * inside a session and confirm sync is alive. Compose / branch /
 * advance arc are deferred until use-and-fix surfaces a need.
 */
export function SessionDetailScreen({ route }: ScreenProps<{ id: string }>) {
  const id = route?.params?.id ?? ''
  const collection = useMemo(() => createMessagesCollection(id), [id])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery(collection as any)

  type Cached = { id: string; role: string; parts: Array<{ type?: string; text?: string }> }
  const messages = useMemo(() => {
    if (!data) return [] as Cached[]
    return (data as Cached[]).slice(-200) // tail clamp; full list can be huge
  }, [data])

  if (!id) return <EmptyState message="No session id provided." />
  if (isLoading && messages.length === 0) return <LoadingState />

  return (
    <View style={layout.page}>
      <PageHeader title="Session" subtitle={id.slice(0, 12)} />
      <FlatList
        contentContainerStyle={layout.pad}
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => <MessageRow message={item} />}
        ListEmptyComponent={<EmptyState message="No messages yet." />}
      />
    </View>
  )
}

function MessageRow({
  message,
}: {
  message: { id: string; role: string; parts: Array<{ type?: string; text?: string }> }
}) {
  const text = message.parts
    .map((p) => p.text)
    .filter(Boolean)
    .join('\n')
    .trim()
  const isUser = message.role === 'user'
  return (
    <View
      style={{
        ...card.base,
        backgroundColor: isUser ? palette.surfaceAlt : palette.surface,
        marginBottom: 8,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View
          style={{
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 4,
            backgroundColor: isUser ? 'rgba(76,159,255,0.18)' : 'rgba(255,255,255,0.06)',
          }}
        >
          <MessageRoleLabel role={message.role} />
        </View>
      </View>
      {text ? (
        <Text style={{ fontSize: 14, color: palette.text }}>{text}</Text>
      ) : (
        <Text style={{ fontSize: 12, color: palette.textDim }}>
          {message.parts.length} non-text part{message.parts.length === 1 ? '' : 's'} (tool /
          attachments)
        </Text>
      )}
    </View>
  )
}

function MessageRoleLabel({ role }: { role: string }) {
  return (
    <Text style={{ fontSize: 10, fontWeight: '700', color: palette.textMuted, letterSpacing: 1 }}>
      {role.toUpperCase()}
    </Text>
  )
}

// ---- Arc detail -------------------------------------------------------

/**
 * ArcDetailScreen — title, status, sessions list. Mirrors the web
 * arc detail at /arc/$arcId minus the editable-title / branch-tree
 * affordances (those involve PATCH dialogs that aren't worth porting
 * without the use-and-fix gate exposing a native need).
 */
export function ArcDetailScreen({ navigation, route }: ScreenProps<{ arcId: string }>) {
  const arcId = route?.params?.arcId ?? ''
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery(arcsCollection as any)
  const arc = useMemo(() => {
    if (!data) return null
    return (data as ArcSummary[]).find((a) => a.id === arcId) ?? null
  }, [data, arcId])

  if (!arcId) return <EmptyState message="No arc id provided." />
  if (isLoading && !arc) return <LoadingState />
  if (!arc) return <EmptyState message="Arc not found — it may have been closed." />

  const externalLabel: string | null =
    arc.externalRef?.provider === 'github'
      ? `#${arc.externalRef.id}`
      : arc.externalRef?.id != null
        ? String(arc.externalRef.id)
        : null
  const worktreeLabel = arc.worktreeReservation?.worktree.split('/').pop() ?? null

  return (
    <View style={layout.page}>
      <PageHeader title={arc.title || externalLabel || 'Arc'} subtitle={arc.id.slice(0, 8)} />
      <ScrollView contentContainerStyle={layout.pad}>
        <View style={card.base}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <StatusPill status={arc.status} />
            {externalLabel ? <BadgeChip label={externalLabel} /> : null}
            {worktreeLabel ? <BadgeChip label={`worktree: ${worktreeLabel}`} /> : null}
          </View>
        </View>

        <Text style={[text.h3, { marginBottom: 8 }]}>Sessions ({arc.sessions.length})</Text>
        {arc.sessions.length === 0 ? (
          <Text style={text.muted}>No sessions in this arc yet.</Text>
        ) : (
          arc.sessions.map((s) => (
            <Pressable
              key={s.id}
              onPress={() => navigation?.navigate('SessionDetail', { id: s.id })}
              style={({ pressed }) => [card.base, pressed ? card.pressed : null]}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <StatusPill status={s.status} />
                <Text style={[text.small, { flex: 1 }]} numberOfLines={1}>
                  {s.mode ?? 'session'} · {formatRelativePast(s.lastActivity) ?? '—'}
                </Text>
              </View>
              <Text style={text.small}>{s.id.slice(0, 12)}</Text>
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  )
}

function BadgeChip({ label }: { label: string }) {
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: palette.surfaceAlt,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: palette.borderStrong,
      }}
    >
      <Text style={{ fontSize: 11, color: palette.textMuted }}>{label}</Text>
    </View>
  )
}

// ---- Board (read-only kanban) -----------------------------------------

/**
 * BoardScreen wraps the read-only `KanbanBoardNative` (existing — see
 * `~/features/kanban/KanbanBoardNative.tsx`) so the Board tab mounts the
 * real arc-list rendering instead of a stub. The DnD upgrade lives in
 * KanbanBoardNative itself (see GH#157 §5).
 */
export function BoardScreen() {
  return <KanbanBoardNative />
}

// ---- Projects ---------------------------------------------------------

/**
 * ProjectsScreen — visibility-filtered list (admin sees all; non-admin
 * sees public + owned-private). Mirrors routes/_authenticated/projects.tsx.
 */
export function ProjectsScreen({ navigation }: ScreenProps) {
  const { data: authSession } = useSession() as {
    data: { user?: { id?: string; role?: string } } | null
  }
  const userId = authSession?.user?.id ?? null
  const role = authSession?.user?.role ?? 'user'
  const isAdmin = role === 'admin'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: projectRows, isLoading } = useLiveQuery(projectsCollection as any)
  const projects = (projectRows ?? []) as ProjectInfo[]

  const visible = projects
    .filter((p) => {
      if (isAdmin) return true
      if (p.visibility !== 'private') return true
      return p.ownerId === userId
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  if (isLoading && visible.length === 0) return <LoadingState />

  return (
    <View style={layout.page}>
      <PageHeader
        title="Projects"
        subtitle={`${visible.length} project${visible.length === 1 ? '' : 's'}`}
      />
      {visible.length === 0 ? (
        <EmptyState message="No projects discovered yet — the gateway syncs every 30s." />
      ) : (
        <FlatList
          contentContainerStyle={layout.pad}
          data={visible}
          keyExtractor={(p) => p.name}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation?.navigate('ProjectDocs', { projectId: item.name })}
              style={({ pressed }) => [card.base, pressed ? card.pressed : null]}
            >
              <Text style={text.h3}>{item.name}</Text>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <BadgeChip label={item.visibility ?? 'public'} />
                {item.branch ? <BadgeChip label={item.branch} /> : null}
                {item.dirty ? <BadgeChip label="dirty" /> : null}
              </View>
              {item.repo_origin ? <Text style={text.small}>{item.repo_origin}</Text> : null}
            </Pressable>
          )}
        />
      )}
    </View>
  )
}

// ---- Project docs (placeholder — editor too web-coupled) --------------

/**
 * ProjectDocsScreen — the docs editor (BlockNote + Yjs CRDT) is deeply
 * DOM-coupled and not worth porting to RN. Surface a clear "use web"
 * message + the project context so the route is real, not a 404.
 *
 * Tracked: GH#161 (native port of BlockNote+Yjs docs editor).
 */
export function ProjectDocsScreen({ route }: ScreenProps<{ projectId: string }>) {
  const projectId = route?.params?.projectId ?? '—'
  return (
    <View style={layout.page}>
      <PageHeader title="Docs" subtitle={projectId} />
      <View style={[layout.pad, { gap: 12 }]}>
        <View style={card.base}>
          <Text style={text.h3}>Open the docs editor on web</Text>
          <Text style={text.muted}>
            The collaborative docs editor (BlockNote + Yjs) hasn't been ported to native yet. Open
            this project's docs from the desktop web app for full editing. Tracking native port in
            GH#161.
          </Text>
          <Text style={text.small}>{`/projects/${projectId}/docs`}</Text>
        </View>
      </View>
    </View>
  )
}

// ---- Deploys ----------------------------------------------------------

type DeployPhase = {
  name: string
  status: string
  startedAt?: string | null
  finishedAt?: string | null
}
type DeployState = {
  status: string
  worker?: { status: string }
  current?: { id?: string; phases?: DeployPhase[] }
  phases?: DeployPhase[]
}

/**
 * DeploysScreen — minimal poll over /api/deploys/:repo/state (the
 * existing endpoint the web /deploys page consumes). Renders the
 * top-level worker status + phase summary; no log streaming, no
 * tab switching across repos. Use-and-fix can iterate.
 */
export function DeploysScreen() {
  const [state, setState] = useState<DeployState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const repo = 'duraclaw' // single repo on native for v1

  useEffect(() => {
    let cancelled = false
    let interval: ReturnType<typeof setInterval> | null = null
    const tick = async () => {
      try {
        const resp = await fetch(apiUrl(`/api/deploys/${repo}/state`), { credentials: 'include' })
        if (!resp.ok) throw new Error(`deploys fetch ${resp.status}`)
        const json = (await resp.json()) as DeployState
        if (!cancelled) setState(json)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void tick()
    interval = setInterval(tick, 5000)
    return () => {
      cancelled = true
      if (interval) clearInterval(interval)
    }
  }, [])

  const phases = state?.current?.phases ?? state?.phases ?? []

  return (
    <View style={layout.page}>
      <PageHeader title="Deploys" subtitle={repo} />
      <ScrollView contentContainerStyle={layout.pad}>
        {error ? (
          <View
            style={{
              ...card.base,
              backgroundColor: palette.destructiveBg,
              borderColor: palette.destructive,
            }}
          >
            <Text style={{ color: palette.destructive }}>Error: {error}</Text>
          </View>
        ) : null}

        <View style={card.base}>
          <Text style={text.h3}>Worker</Text>
          <StatusPill status={state?.worker?.status ?? 'unknown'} />
        </View>

        <Text style={[text.h3, { marginBottom: 8 }]}>Phases</Text>
        {phases.length === 0 ? (
          <Text style={text.muted}>No deploy in progress.</Text>
        ) : (
          phases.map((p) => (
            <View key={`${p.name}-${p.startedAt ?? ''}`} style={card.base}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <StatusPill status={p.status} />
                <Text style={[text.body, { flex: 1 }]}>{p.name}</Text>
              </View>
              {p.startedAt ? (
                <Text style={text.small}>started {formatRelativePast(p.startedAt) ?? '—'}</Text>
              ) : null}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  )
}

// ---- Settings ---------------------------------------------------------

/**
 * SettingsScreen — drastically simplified vs the 37KB web settings
 * (which has tabs for permissions, models, defaults, FCM subs,
 * project ownership, etc.). On native we surface the must-haves:
 *   - identity (email)
 *   - sign out
 *   - admin links (if admin)
 *   - settings/test sub-page link
 *
 * The fine-grained model / permission / FCM controls live on the web
 * settings page; native users can dogfood and surface needs via use-
 * and-fix.
 */
export function SettingsScreen({ navigation }: ScreenProps) {
  const session = useSession() as {
    data: { user?: { email?: string; role?: string; name?: string } } | null
  }
  const user = session.data?.user ?? null
  const isAdmin = user?.role === 'admin'

  const [signingOut, setSigningOut] = useState(false)

  const onSignOut = async () => {
    if (signingOut) return
    setSigningOut(true)
    try {
      await signOut()
    } catch (err) {
      console.error('[settings-native] signOut threw:', err)
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <View style={layout.page}>
      <PageHeader title="Settings" subtitle={user?.email ?? '—'} />
      <ScrollView contentContainerStyle={layout.pad}>
        <View style={card.base}>
          <Text style={text.eyebrow}>ACCOUNT</Text>
          {user?.name ? <Text style={text.body}>{user.name}</Text> : null}
          {user?.email ? <Text style={text.muted}>{user.email}</Text> : null}
          {user?.role ? <BadgeChip label={user.role} /> : null}
        </View>

        <View style={card.base}>
          <Text style={text.eyebrow}>NAVIGATION</Text>
          <SettingsLink
            label="Settings · Test"
            onPress={() => navigation?.navigate('SettingsTest')}
          />
          {isAdmin ? (
            <>
              <SettingsLink
                label="Admin · Users"
                onPress={() => navigation?.navigate('AdminUsers')}
              />
              <SettingsLink
                label="Admin · Codex Models"
                onPress={() => navigation?.navigate('AdminCodexModels')}
              />
              <SettingsLink
                label="Admin · Gemini Models"
                onPress={() => navigation?.navigate('AdminGeminiModels')}
              />
            </>
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          disabled={signingOut}
          onPress={onSignOut}
          style={({ pressed }) => [
            button.destructive,
            signingOut || pressed ? button.pressed : null,
          ]}
          testID="settings-sign-out"
        >
          {signingOut ? (
            <ActivityIndicator color={palette.destructive} />
          ) : (
            <Text style={button.destructiveLabel}>Sign out</Text>
          )}
        </Pressable>

        <Text style={[text.small, { marginTop: 16, textAlign: 'center' }]}>
          Fine-grained model / permission / FCM settings live on the web app.
        </Text>
      </ScrollView>
    </View>
  )
}

function SettingsLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        {
          paddingVertical: 12,
          paddingHorizontal: 4,
          borderBottomColor: palette.border,
          borderBottomWidth: StyleSheet.hairlineWidth,
        },
        pressed ? { opacity: 0.6 } : null,
      ]}
    >
      <Text style={text.body}>{label}</Text>
    </Pressable>
  )
}

/**
 * SettingsTestScreen — placeholder. Web's settings.test.tsx is a
 * 13KB grab-bag of dev-only toggles (FCM subscription debug, etc.)
 * that aren't useful on native. Render a notice so the route is
 * navigable without surprising the user.
 */
export function SettingsTestScreen() {
  return (
    <View style={layout.page}>
      <PageHeader title="Settings · Test" subtitle="Dev affordances" />
      <View style={[layout.pad, { gap: 12 }]}>
        <View style={card.base}>
          <Text style={text.h3}>Web-only</Text>
          <Text style={text.muted}>
            The dev-test toggles (FCM subscription debug, theme cycle, connection-manager poker)
            live on the web settings/test page. Open the web app to use them.
          </Text>
        </View>
      </View>
    </View>
  )
}

// ---- Admin screens ----------------------------------------------------

function AdminGate({
  children,
  navigation,
}: {
  children: React.ReactNode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  navigation?: any
}) {
  const session = useSession() as { data: { user?: { role?: string } } | null }
  const role = session.data?.user?.role ?? 'user'
  if (role !== 'admin') {
    return (
      <View style={layout.page}>
        <PageHeader title="Admin" subtitle="Restricted" />
        <View style={[layout.pad, { gap: 12 }]}>
          <View style={card.base}>
            <Text style={text.h3}>Admin access required</Text>
            <Text style={text.muted}>
              You need an admin role to view this page. Contact a workspace owner if this is
              unexpected.
            </Text>
          </View>
          {navigation ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation.navigate('SettingsIndex')}
              style={({ pressed }) => [button.secondary, pressed ? button.pressed : null]}
            >
              <Text style={button.secondaryLabel}>Back to settings</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    )
  }
  return <>{children}</>
}

type AdminUserRow = {
  id: string
  email: string
  name?: string | null
  role?: string | null
  createdAt?: string
}

/**
 * AdminUsersScreen — read-only user list. The web page has CRUD
 * (create/promote/ban/delete via shadcn dialogs); native is read-only
 * for v1. Use the web app for admin actions.
 *
 * Settings admin sections (Projects visibility / Identities / System)
 * are tracked separately in GH#162 — those don't have native equivalents
 * yet and are accessed via web.
 */
export function AdminUsersScreen({ navigation }: ScreenProps) {
  return (
    <AdminGate navigation={navigation}>
      <AdminUsersInner />
    </AdminGate>
  )
}

function AdminUsersInner() {
  const [users, setUsers] = useState<AdminUserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const lastFetchRef = useRef<number>(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        // Better Auth admin plugin exposes listUsers via the auth client.
        // Use the REST endpoint directly so we don't pull web-only deps.
        const resp = await fetch(apiUrl('/api/auth/admin/list-users?limit=200'), {
          credentials: 'include',
        })
        if (!resp.ok) throw new Error(`list-users ${resp.status}`)
        const json = (await resp.json()) as { users?: AdminUserRow[] }
        if (!cancelled) {
          setUsers(json.users ?? [])
          setError(null)
          lastFetchRef.current = Date.now()
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) return <LoadingState />

  return (
    <View style={layout.page}>
      <PageHeader title="Admin · Users" subtitle={`${users.length} users`} />
      {error ? (
        <View style={[layout.pad]}>
          <View
            style={{
              ...card.base,
              backgroundColor: palette.destructiveBg,
              borderColor: palette.destructive,
            }}
          >
            <Text style={{ color: palette.destructive }}>{error}</Text>
            <Text style={text.small}>Read-only on native. Use the web app for admin actions.</Text>
          </View>
        </View>
      ) : null}
      <FlatList
        contentContainerStyle={layout.pad}
        data={users}
        keyExtractor={(u) => u.id}
        renderItem={({ item }) => (
          <View style={card.base}>
            <Text style={text.h3}>{item.name || item.email}</Text>
            <Text style={text.muted}>{item.email}</Text>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <BadgeChip label={item.role ?? 'user'} />
              {item.createdAt ? (
                <BadgeChip label={`joined ${formatRelativePast(item.createdAt) ?? ''}`} />
              ) : null}
            </View>
          </View>
        )}
        ListEmptyComponent={!error ? <EmptyState message="No users." /> : null}
      />
    </View>
  )
}

type AdminModelRow = {
  id: string
  label?: string | null
  provider?: string | null
  enabled?: boolean
}

function AdminModelsList({ endpoint, title }: { endpoint: string; title: string }) {
  const [models, setModels] = useState<AdminModelRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch(apiUrl(endpoint), { credentials: 'include' })
        if (!resp.ok) throw new Error(`${endpoint} ${resp.status}`)
        const json = (await resp.json()) as { models?: AdminModelRow[] }
        if (!cancelled) setModels(json.models ?? [])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [endpoint])

  if (loading) return <LoadingState />

  return (
    <View style={layout.page}>
      <PageHeader
        title={title}
        subtitle={`${models.length} model${models.length === 1 ? '' : 's'}`}
      />
      {error ? (
        <View style={[layout.pad]}>
          <View
            style={{
              ...card.base,
              backgroundColor: palette.destructiveBg,
              borderColor: palette.destructive,
            }}
          >
            <Text style={{ color: palette.destructive }}>{error}</Text>
            <Text style={text.small}>Read-only on native — manage from the web app.</Text>
          </View>
        </View>
      ) : null}
      <FlatList
        contentContainerStyle={layout.pad}
        data={models}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <View style={card.base}>
            <Text style={text.h3}>{item.label || item.id}</Text>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {item.provider ? <BadgeChip label={item.provider} /> : null}
              <BadgeChip label={item.enabled ? 'enabled' : 'disabled'} />
            </View>
          </View>
        )}
        ListEmptyComponent={!error ? <EmptyState message="No models configured." /> : null}
      />
    </View>
  )
}

export function AdminCodexModelsScreen({ navigation }: ScreenProps) {
  return (
    <AdminGate navigation={navigation}>
      <AdminModelsList endpoint="/api/admin/codex-models" title="Admin · Codex Models" />
    </AdminGate>
  )
}

export function AdminGeminiModelsScreen({ navigation }: ScreenProps) {
  return (
    <AdminGate navigation={navigation}>
      <AdminModelsList endpoint="/api/admin/gemini-models" title="Admin · Gemini Models" />
    </AdminGate>
  )
}

// useNavigation is exported by react-navigation; import remains for future
// screens that lift navigation out of the prop chain. Keeping the import
// avoids round-tripping when the next screen needs it.
void useNavigation
