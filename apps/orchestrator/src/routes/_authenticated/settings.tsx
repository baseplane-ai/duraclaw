import type { ProjectInfo } from '@duraclaw/shared-types'
import { useLiveQuery } from '@tanstack/react-db'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { NotificationPreferences } from '~/components/notification-preferences'
import { TransferOwnershipDialog } from '~/components/projects/TransferOwnershipDialog'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { RadioGroup, RadioGroupItem } from '~/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { VisibilityBadge } from '~/components/visibility-badge'
import { useLayout } from '~/context/layout-provider'
import { useTheme } from '~/context/theme-provider'
import { projectsCollection } from '~/db/projects-collection'
import { useSwUpdate } from '~/hooks/use-sw-update'
import { useUserDefaults } from '~/hooks/use-user-defaults'
import { signOut, useSession as useAuthSession } from '~/lib/auth-client'
import { apiUrl } from '~/lib/platform'

const CLAUDE_MODELS = [
  { value: 'claude-opus-4-7', label: 'claude-opus-4-7' },
  { value: 'claude-opus-4-6', label: 'claude-opus-4-6' },
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
  { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5' },
]

const CODEX_MODELS = [
  { value: 'gpt-5.1', label: 'gpt-5.1' },
  { value: 'gpt-5.4', label: 'gpt-5.4' },
  { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
  { value: 'o4-mini', label: 'o4-mini' },
]

function isCodexModel(model: string | undefined): boolean {
  if (!model) return false
  return (
    CODEX_MODELS.some((m) => m.value === model) || model.startsWith('gpt-') || model === 'o4-mini'
  )
}

const PERMISSION_MODES = [
  { value: 'default', label: 'Default', description: 'Ask for permission on risky actions' },
  { value: 'acceptEdits', label: 'Accept Edits', description: 'Auto-accept file edits' },
  {
    value: 'bypassPermissions',
    label: 'Bypass',
    description: 'Skip all permission prompts',
  },
  { value: 'plan', label: 'Plan', description: 'Plan only, no execution' },
  { value: 'dontAsk', label: "Don't Ask", description: 'Never ask questions' },
  { value: 'auto', label: 'Auto', description: 'Fully autonomous mode' },
]

const THINKING_MODES = [
  { value: 'adaptive', label: 'Adaptive' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
]

const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'xHigh' },
  { value: 'max', label: 'Max' },
]

export const Route = createFileRoute('/_authenticated/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  return (
    <>
      <Header>
        <h1 className="text-lg font-semibold">Settings</h1>
      </Header>
      <Main>
        <div className="mx-auto max-w-3xl flex flex-col gap-6">
          <AccountSection />
          <DefaultsSection />
          <ProjectsSection />
          <IdentitiesSection />
          <NotificationsSection />
          <AppearanceSection />
          <SystemSection />
        </div>
      </Main>
    </>
  )
}

function AccountSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>Manage your account settings.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          onClick={() => {
            signOut().finally(() => {
              window.location.href = '/login'
            })
          }}
        >
          Sign Out
        </Button>
      </CardContent>
    </Card>
  )
}

function DefaultsSection() {
  const { preferences, updatePreferences, loading } = useUserDefaults()

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Defaults</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading preferences...</p>
        </CardContent>
      </Card>
    )
  }

  // The settings UI is per-driver (tabs below). Each tab persists to its
  // own column — `model` for Claude, `codexModel` for Codex — and they
  // don't shadow each other. SpawnAgentForm picks which one to send based
  // on the driver the user selects at spawn time. We default the visible
  // tab to whichever driver `preferences.model` looks like, so users who
  // historically had `model: 'gpt-5.4'` (pre-split) still land on the
  // Codex surface on first paint.
  const defaultTab = isCodexModel(preferences.model) ? 'codex' : 'claude'

  const handleClaudeModelChange = (value: string) => {
    updatePreferences({ model: value })
  }
  const handleCodexModelChange = (value: string) => {
    updatePreferences({ codexModel: value })
  }

  const maxBudgetField = (
    <div className="flex flex-col gap-2">
      <Label htmlFor="max-budget">Max Budget (USD)</Label>
      <Input
        id="max-budget"
        type="number"
        min={0}
        step={0.5}
        className="w-full max-w-xs"
        placeholder="No limit"
        value={preferences.maxBudget ?? ''}
        onChange={(e) => {
          const val = e.target.value
          updatePreferences({
            maxBudget: val === '' ? null : Number.parseFloat(val),
          })
        }}
      />
      <p className="text-xs text-muted-foreground">
        Maximum spend per session. Leave empty for no limit.
      </p>
    </div>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Defaults</CardTitle>
        <CardDescription>
          Default values for new sessions. These can be overridden per session.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue={defaultTab} className="w-full">
          <TabsList>
            <TabsTrigger value="claude">Claude</TabsTrigger>
            <TabsTrigger value="codex">Codex</TabsTrigger>
          </TabsList>

          <TabsContent value="claude" className="flex flex-col gap-6 pt-4">
            {/* Permission Mode */}
            <div className="flex flex-col gap-3">
              <Label className="text-sm font-medium">Permission Mode</Label>
              <RadioGroup
                value={preferences.permissionMode}
                onValueChange={(value) => updatePreferences({ permissionMode: value })}
                className="grid gap-2"
              >
                {PERMISSION_MODES.map((mode) => (
                  <div key={mode.value} className="flex items-start gap-2">
                    <RadioGroupItem
                      value={mode.value}
                      id={`perm-${mode.value}`}
                      className="mt-0.5"
                    />
                    <div className="grid gap-0.5">
                      <Label htmlFor={`perm-${mode.value}`} className="cursor-pointer text-sm">
                        {mode.label}
                      </Label>
                      <p className="text-xs text-muted-foreground">{mode.description}</p>
                    </div>
                  </div>
                ))}
              </RadioGroup>
            </div>

            {/* Claude Model */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="claude-model">Model</Label>
              <Select
                value={isCodexModel(preferences.model) ? CLAUDE_MODELS[0].value : preferences.model}
                onValueChange={handleClaudeModelChange}
              >
                <SelectTrigger id="claude-model" className="w-full max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLAUDE_MODELS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Thinking Mode */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="thinking-mode">Thinking Mode</Label>
              <Select
                value={preferences.thinkingMode}
                onValueChange={(value) => updatePreferences({ thinkingMode: value })}
              >
                <SelectTrigger id="thinking-mode" className="w-full max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {THINKING_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Effort */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="effort">Effort</Label>
              <Select
                value={preferences.effort}
                onValueChange={(value) => updatePreferences({ effort: value })}
              >
                <SelectTrigger id="effort" className="w-full max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EFFORT_OPTIONS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {maxBudgetField}
          </TabsContent>

          <TabsContent value="codex" className="flex flex-col gap-6 pt-4">
            {/* Codex Model */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="codex-model">Model</Label>
              <Select
                value={preferences.codexModel ?? CODEX_MODELS[0].value}
                onValueChange={handleCodexModelChange}
              >
                <SelectTrigger id="codex-model" className="w-full max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CODEX_MODELS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Permission, thinking, and effort defaults are Claude-only — codex spawns use the
                codex CLI's native settings.
              </p>
            </div>

            {maxBudgetField}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function NotificationsSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>Configure which events trigger push notifications.</CardDescription>
      </CardHeader>
      <CardContent>
        <NotificationPreferences />
      </CardContent>
    </Card>
  )
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const { variant, setVariant } = useLayout()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Customize the look and feel of the application.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Theme */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="theme-select">Theme</Label>
          <Select value={theme} onValueChange={setTheme}>
            <SelectTrigger id="theme-select" className="w-full max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Sidebar Variant */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="sidebar-variant">Sidebar Variant</Label>
          <Select value={variant} onValueChange={setVariant}>
            <SelectTrigger id="sidebar-variant" className="w-full max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inset">Inset</SelectItem>
              <SelectItem value="floating">Floating</SelectItem>
              <SelectItem value="sidebar">Sidebar</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  )
}

function ProjectsSection() {
  const { data: authSession } = useAuthSession()
  const role = (authSession as { user?: { role?: string } } | null)?.user?.role ?? 'user'
  const isAdmin = role === 'admin'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: projectRows } = useLiveQuery(projectsCollection as any)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  // GH#122 P4 / B-UI-5: admin reassign dialog target.
  const [transferTarget, setTransferTarget] = useState<ProjectInfo | null>(null)

  const handleToggle = useCallback(async (name: string, current: 'public' | 'private') => {
    const next = current === 'public' ? 'private' : 'public'
    setPending((prev) => new Set(prev).add(name))
    setErrors((prev) => {
      const { [name]: _, ...rest } = prev
      return rest
    })
    try {
      const resp = await fetch(apiUrl(`/api/projects/${encodeURIComponent(name)}/visibility`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ visibility: next }),
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        setErrors((prev) => ({ ...prev, [name]: `Failed (${resp.status}) ${body}` }))
      }
      // Synced-collection delta from the PATCH handler updates the row
      // reactively — no manual refresh.
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        [name]: err instanceof Error ? err.message : String(err),
      }))
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
    }
  }, [])

  if (!isAdmin) return null

  const projects = (projectRows ?? []) as ProjectInfo[]
  const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Projects</CardTitle>
        <CardDescription>
          Toggle project visibility. Public projects — and the sessions inside them — are visible to
          every authenticated user. Private projects are scoped to their owner. New projects default
          to public.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">No projects yet.</p>
        ) : (
          <ul className="divide-y">
            {sorted.map((p) => {
              const visibility: 'public' | 'private' =
                p.visibility === 'private' ? 'private' : 'public'
              const busy = pending.has(p.name)
              const err = errors[p.name]
              const ownerLabel = p.ownerId ? p.ownerId.slice(0, 8) : 'unowned'
              return (
                <li key={p.name} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate font-mono">{p.name}</span>
                    <VisibilityBadge visibility={visibility} showLabel />
                    <span className="text-xs text-muted-foreground">Owner: {ownerLabel}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {err && <span className="text-xs text-destructive">{err}</span>}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => handleToggle(p.name, visibility)}
                    >
                      {busy ? 'Saving…' : visibility === 'public' ? 'Make private' : 'Make public'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!p.projectId}
                      title={p.projectId ? undefined : 'Project not yet synced'}
                      onClick={() => setTransferTarget(p)}
                    >
                      Reassign
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
      {transferTarget?.projectId && (
        <TransferOwnershipDialog
          projectId={transferTarget.projectId}
          projectName={transferTarget.name}
          currentOwnerId={transferTarget.ownerId ?? null}
          currentUserRole="admin"
          onClose={() => setTransferTarget(null)}
        />
      )}
    </Card>
  )
}

// ── Identities (admin only, GH#119 P4) ─────────────────────────────

interface IdentityRow {
  id: string
  name: string
  status: 'available' | 'cooldown' | 'disabled' | string
  cooldownUntil: string | null
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Format an ISO timestamp as "in 23m" / "in 2h" / "in 3d" / "expired" relative
 * to now. `null` returns null so callers can elide the suffix entirely.
 */
function formatRelativeFuture(iso: string | null): string | null {
  if (!iso) return null
  const target = new Date(iso).getTime()
  if (Number.isNaN(target)) return null
  const deltaMs = target - Date.now()
  if (deltaMs <= 0) return 'expired'
  const mins = Math.round(deltaMs / 60_000)
  if (mins < 60) return `in ${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `in ${hrs}h`
  const days = Math.round(hrs / 24)
  return `in ${days}d`
}

function formatRelativePast(iso: string | null): string | null {
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

function IdentityStatusBadge({
  status,
  cooldownUntil,
}: {
  status: string
  cooldownUntil: string | null
}) {
  if (status === 'cooldown') {
    const rel = formatRelativeFuture(cooldownUntil)
    return (
      <Badge variant="outline" className="border-amber-500/50 text-amber-500">
        <span className="mr-1 inline-block size-2 rounded-full bg-amber-500" />
        cooldown{rel ? ` (${rel})` : ''}
      </Badge>
    )
  }
  if (status === 'disabled') {
    return (
      <Badge variant="outline" className="border-muted-foreground/50 text-muted-foreground">
        <span className="mr-1 inline-block size-2 rounded-full bg-muted-foreground" />
        disabled
      </Badge>
    )
  }
  // 'available' (or anything else — fall through to the green dot)
  return (
    <Badge variant="outline" className="border-green-500/50 text-green-500">
      <span className="mr-1 inline-block size-2 rounded-full bg-green-500" />
      available
    </Badge>
  )
}

function IdentitiesSection() {
  const { data: authSession } = useAuthSession()
  const role = (authSession as { user?: { role?: string } } | null)?.user?.role ?? 'user'
  const isAdmin = role === 'admin'

  const [rows, setRows] = useState<IdentityRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [createName, setCreateName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch(apiUrl('/api/admin/identities'), {
        credentials: 'include',
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        setLoadError(`Failed to load (${resp.status}) ${body}`)
        return
      }
      const json = (await resp.json()) as { identities?: IdentityRow[] }
      setRows(Array.isArray(json.identities) ? json.identities : [])
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    if (!isAdmin) return
    void refresh()
  }, [isAdmin, refresh])

  const handleCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const name = createName.trim()
      if (!name) {
        setCreateError('Name is required')
        return
      }
      setCreating(true)
      setCreateError(null)
      try {
        const resp = await fetch(apiUrl('/api/admin/identities'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ name }),
        })
        if (!resp.ok) {
          const body = (await resp.json().catch(() => null)) as {
            error?: string
            field?: string
            detail?: string
          } | null
          const errCode = body?.error ?? `http_${resp.status}`
          const msg =
            errCode === 'duplicate_identity_name'
              ? `Identity "${name}" already exists`
              : errCode === 'missing_required_field'
                ? `Missing required field: ${body?.field ?? 'unknown'}`
                : errCode === 'invalid_name'
                  ? `Invalid name — ${body?.detail ?? 'must match [A-Za-z0-9_-]{1,64}'}`
                  : errCode
          setCreateError(msg)
          return
        }
        setCreateName('')
        await refresh()
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : String(err))
      } finally {
        setCreating(false)
      }
    },
    [createName, refresh],
  )

  const markPending = useCallback((id: string, busy: boolean) => {
    setPending((prev) => {
      const next = new Set(prev)
      if (busy) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const handleToggleStatus = useCallback(
    async (row: IdentityRow) => {
      const next = row.status === 'disabled' ? 'available' : 'disabled'
      markPending(row.id, true)
      setRowErrors((prev) => {
        const { [row.id]: _, ...rest } = prev
        return rest
      })
      try {
        const resp = await fetch(apiUrl(`/api/admin/identities/${encodeURIComponent(row.id)}`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ status: next }),
        })
        if (!resp.ok) {
          const body = await resp.text().catch(() => '')
          setRowErrors((prev) => ({ ...prev, [row.id]: `Failed (${resp.status}) ${body}` }))
          return
        }
        await refresh()
      } catch (err) {
        setRowErrors((prev) => ({
          ...prev,
          [row.id]: err instanceof Error ? err.message : String(err),
        }))
      } finally {
        markPending(row.id, false)
      }
    },
    [markPending, refresh],
  )

  const handleDelete = useCallback(
    async (row: IdentityRow) => {
      if (!window.confirm(`Delete identity "${row.name}"?\n\nThis cannot be undone.`)) {
        return
      }
      markPending(row.id, true)
      setRowErrors((prev) => {
        const { [row.id]: _, ...rest } = prev
        return rest
      })
      try {
        const resp = await fetch(apiUrl(`/api/admin/identities/${encodeURIComponent(row.id)}`), {
          method: 'DELETE',
          credentials: 'include',
        })
        if (!resp.ok && resp.status !== 204) {
          const body = await resp.text().catch(() => '')
          setRowErrors((prev) => ({ ...prev, [row.id]: `Failed (${resp.status}) ${body}` }))
          return
        }
        await refresh()
      } catch (err) {
        setRowErrors((prev) => ({
          ...prev,
          [row.id]: err instanceof Error ? err.message : String(err),
        }))
      } finally {
        markPending(row.id, false)
      }
    },
    [markPending, refresh],
  )

  if (!isAdmin) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Identities</CardTitle>
        <CardDescription>
          Runner identities for account failover (GH#119). Each identity maps to a HOME directory
          containing its own Claude credentials. The orchestrator picks an available identity at
          spawn time and falls over to another when one hits a rate limit.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Add form */}
        <form onSubmit={handleCreate} className="flex flex-col gap-2 rounded-md border p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="flex flex-col gap-1">
              <Label htmlFor="identity-name" className="text-xs">
                Name
              </Label>
              <Input
                id="identity-name"
                placeholder="work2"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                disabled={creating}
              />
              <p className="text-xs text-muted-foreground">
                HOME directory is derived as{' '}
                <span className="font-mono">{`<IDENTITY_HOME_BASE>/${createName.trim() || 'name'}`}</span>
                . Allowed characters: <span className="font-mono">[A-Za-z0-9_-]</span>, max 64
                chars.
              </p>
            </div>
            <Button type="submit" disabled={creating || !createName.trim()}>
              {creating ? 'Adding…' : 'Add identity'}
            </Button>
          </div>
          {createError && <p className="text-xs text-destructive">{createError}</p>}
        </form>

        {/* List */}
        {loadError ? (
          <p className="text-sm text-destructive">{loadError}</p>
        ) : rows === null ? (
          <p className="text-sm text-muted-foreground">Loading identities…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No identities configured. The orchestrator will use the gateway's default HOME until you
            add one.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {rows.map((row) => {
              const busy = pending.has(row.id)
              const err = rowErrors[row.id]
              const lastUsed = formatRelativePast(row.lastUsedAt)
              return (
                <li key={row.id} className="flex flex-col gap-1 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="truncate font-mono">{row.name}</span>
                      <IdentityStatusBadge status={row.status} cooldownUntil={row.cooldownUntil} />
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => handleToggleStatus(row)}
                      >
                        {busy ? 'Saving…' : row.status === 'disabled' ? 'Enable' : 'Disable'}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => handleDelete(row)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {lastUsed && <span>last used {lastUsed}</span>}
                  </div>
                  {err && <p className="text-xs text-destructive">{err}</p>}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function SystemSection() {
  const { updateAvailable, localHash, remoteHash, applyUpdate } = useSwUpdate()
  const matched = localHash && remoteHash && localHash === remoteHash

  return (
    <Card>
      <CardHeader>
        <CardTitle>System</CardTitle>
        <CardDescription>Application version and maintenance.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 rounded-md border p-3 font-mono text-xs">
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Running</span>
            <span>{localHash ?? '...'}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Deployed</span>
            <span>{remoteHash ?? '...'}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Status</span>
            <span className={matched ? 'text-green-500' : updateAvailable ? 'text-amber-500' : ''}>
              {matched ? 'Up to date' : updateAvailable ? 'Update available' : 'Checking...'}
            </span>
          </div>
        </div>
        <Button variant="outline" onClick={() => applyUpdate()}>
          Force Refresh
        </Button>
        <p className="text-xs text-muted-foreground">
          Reload the app with the latest deployed version, clearing cached assets.
        </p>
      </CardContent>
    </Card>
  )
}
