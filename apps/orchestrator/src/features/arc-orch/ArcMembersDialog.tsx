/**
 * ArcMembersDialog — per-arc roster + invitation management (GH#152 P1 / WU-F).
 *
 * Mounted from the arc detail route (`routes/_authenticated/arc.$arcId.tsx`)
 * via a "Members" button in the arc header. Opens read-only for any arc
 * member; owners get add / remove / invite controls. Backed by the four
 * REST endpoints in `apps/orchestrator/src/api/arc-members.ts`.
 *
 * Data-fetching uses a plain `useEffect` + `fetch` pattern (the codebase
 * does NOT use TanStack Query — synced collections cover the realtime
 * surfaces, REST stays request-response). The roster is refetched on
 * every dialog-open and after any successful mutation.
 *
 * The invitation "Revoke" affordance issues a `DELETE
 * /api/arcs/:id/invitations/:token` — the endpoint does not exist yet
 * (P1 only ships add/remove members), so the request currently lands as
 * a 404 and the UI surfaces a graceful "revoke not yet implemented"
 * toast. Wire-up in a follow-up; this keeps the affordance discoverable
 * without blocking on backend.
 */

import { XIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback } from '~/components/ui/avatar'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { useSession as useAuthSession } from '~/lib/auth-client'
import { apiUrl } from '~/lib/platform'
import { cn } from '~/lib/utils'

// ── Types ──────────────────────────────────────────────────────────

interface MemberRow {
  userId: string
  email: string | null
  name: string | null
  role: 'owner' | 'member'
  addedAt: string
  addedBy: string | null
}

interface InvitationRow {
  token: string
  email: string
  role: 'owner' | 'member'
  expiresAt: string
  invitedBy: string
}

interface MembersResponse {
  members: MemberRow[]
  invitations: InvitationRow[]
}

export interface ArcMembersDialogProps {
  arcId: string
  /** Optional arc title for the header. Caller passes from
   *  `arcsCollection`; falls back to "this arc" if absent. */
  arcTitle?: string | null
  open: boolean
  onClose: () => void
}

// ── Helpers ────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function initialsFor(name: string | null, email: string | null): string {
  const source = (name || email || '?').trim()
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    const a = parts[0]?.[0] ?? ''
    const b = parts[1]?.[0] ?? ''
    return (a + b).toUpperCase()
  }
  return source.slice(0, 2).toUpperCase()
}

/** "5m ago" / "3h ago" / "2d ago" — matches arc.$arcId.tsx's helper. */
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

/** "in 6d" / "in 2h" / "expired" — formatter for invitation expiry. */
function formatRelativeFuture(iso: string | null): string {
  if (!iso) return ''
  const target = new Date(iso).getTime()
  if (Number.isNaN(target)) return ''
  const deltaMs = target - Date.now()
  if (deltaMs <= 0) return 'expired'
  const mins = Math.round(deltaMs / 60_000)
  if (mins < 60) return `in ${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `in ${hrs}h`
  const days = Math.round(hrs / 24)
  return `in ${days}d`
}

// ── Component ──────────────────────────────────────────────────────

export function ArcMembersDialog({ arcId, arcTitle, open, onClose }: ArcMembersDialogProps) {
  const { data: authSession } = useAuthSession()
  const currentUserId = (authSession as { user?: { id?: string } } | null)?.user?.id ?? null

  const [tab, setTab] = useState<'members' | 'invites'>('members')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [invitations, setInvitations] = useState<InvitationRow[]>([])

  // Add-member form state.
  const [newEmail, setNewEmail] = useState('')
  const [adding, setAdding] = useState(false)

  // Pending row-level mutation (user id / token) for spinner state.
  const [pendingId, setPendingId] = useState<string | null>(null)

  // Optional confirm-remove state — { userId, name } when set.
  const [confirmRemove, setConfirmRemove] = useState<MemberRow | null>(null)

  const myRole: 'owner' | 'member' | null = useMemo(() => {
    if (!currentUserId) return null
    return members.find((m) => m.userId === currentUserId)?.role ?? null
  }, [members, currentUserId])
  const isOwner = myRole === 'owner'

  // Fetch on open + every successful mutation triggers a refetch via
  // bumping `reloadTick`.
  const [reloadTick, setReloadTick] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick is intentional — bumping it forces a refetch after mutations.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    ;(async () => {
      try {
        const resp = await fetch(apiUrl(`/api/arcs/${encodeURIComponent(arcId)}/members`), {
          credentials: 'include',
        })
        if (cancelled) return
        if (!resp.ok) {
          setLoadError(`Failed to load members (${resp.status})`)
          setMembers([])
          setInvitations([])
          return
        }
        const body = (await resp.json()) as MembersResponse
        if (cancelled) return
        setMembers(body.members ?? [])
        setInvitations(body.invitations ?? [])
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [arcId, open, reloadTick])

  const refresh = useCallback(() => {
    setReloadTick((n) => n + 1)
  }, [])

  // ── Add member ─────────────────────────────────────────────────
  const submitAdd = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault()
      const email = newEmail.trim()
      if (!email) {
        toast.error('Enter an email')
        return
      }
      if (!EMAIL_RE.test(email)) {
        toast.error('Enter a valid email')
        return
      }
      setAdding(true)
      try {
        const resp = await fetch(apiUrl(`/api/arcs/${encodeURIComponent(arcId)}/members`), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        })
        const body = (await resp.json().catch(() => null)) as
          | { kind: 'added'; member: MemberRow }
          | { kind: 'invited'; invitation: InvitationRow }
          | { error?: string }
          | null
        if (!resp.ok) {
          const code = (body && 'error' in body && body.error) || ''
          if (resp.status === 409 && code === 'already_member') {
            toast.error(`${email} is already a member`)
          } else if (resp.status === 422 && code === 'email_required') {
            toast.error('Enter an email')
          } else if (resp.status === 403) {
            toast.error("You don't have permission to add members")
          } else {
            toast.error(`Add failed (${resp.status})`)
          }
          return
        }
        if (body && 'kind' in body) {
          if (body.kind === 'added') {
            toast.success(`Added ${body.member.email ?? email}`)
            setTab('members')
          } else {
            toast.success(`Invited ${body.invitation.email}`)
            setTab('invites')
          }
        }
        setNewEmail('')
        refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error')
      } finally {
        setAdding(false)
      }
    },
    [arcId, newEmail, refresh],
  )

  // ── Remove member ──────────────────────────────────────────────
  const performRemove = useCallback(
    async (member: MemberRow) => {
      setPendingId(member.userId)
      try {
        const resp = await fetch(
          apiUrl(
            `/api/arcs/${encodeURIComponent(arcId)}/members/${encodeURIComponent(member.userId)}`,
          ),
          { method: 'DELETE', credentials: 'include' },
        )
        const body = (await resp.json().catch(() => null)) as {
          removed?: boolean
          error?: string
        } | null
        if (!resp.ok) {
          const code = body?.error ?? ''
          if (resp.status === 409 && code === 'last_owner') {
            toast.error("Can't remove the last owner")
          } else if (resp.status === 403) {
            toast.error("You don't have permission to remove members")
          } else {
            toast.error(`Remove failed (${resp.status})`)
          }
          return
        }
        toast.success(`Removed ${member.name ?? member.email ?? member.userId}`)
        refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error')
      } finally {
        setPendingId(null)
        setConfirmRemove(null)
      }
    },
    [arcId, refresh],
  )

  // ── Resend invite ──────────────────────────────────────────────
  const resendInvite = useCallback(
    async (invitation: InvitationRow) => {
      setPendingId(invitation.token)
      try {
        const resp = await fetch(apiUrl(`/api/arcs/${encodeURIComponent(arcId)}/members`), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: invitation.email }),
        })
        if (!resp.ok) {
          toast.error(`Resend failed (${resp.status})`)
          return
        }
        toast.success(`Resent invitation to ${invitation.email}`)
        refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error')
      } finally {
        setPendingId(null)
      }
    },
    [arcId, refresh],
  )

  // ── Revoke invite (best-effort; backend route may 404) ─────────
  const revokeInvite = useCallback(
    async (invitation: InvitationRow) => {
      setPendingId(invitation.token)
      try {
        const resp = await fetch(
          apiUrl(
            `/api/arcs/${encodeURIComponent(arcId)}/invitations/${encodeURIComponent(invitation.token)}`,
          ),
          { method: 'DELETE', credentials: 'include' },
        )
        if (resp.status === 404) {
          // Endpoint not yet implemented — flag it but don't break the
          // user's mental model.
          toast.error('Revoke is not yet implemented on the backend')
          return
        }
        if (!resp.ok) {
          toast.error(`Revoke failed (${resp.status})`)
          return
        }
        toast.success(`Revoked invitation to ${invitation.email}`)
        refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error')
      } finally {
        setPendingId(null)
      }
    },
    [arcId, refresh],
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Members of {arcTitle?.trim() || 'this arc'}</DialogTitle>
          <DialogDescription>
            {isOwner
              ? 'Invite teammates by email. Existing users join immediately; new emails get an invitation link.'
              : 'You are a member of this arc. Only owners can add or remove members.'}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'members' | 'invites')}>
          <TabsList>
            <TabsTrigger value="members">Members ({members.length})</TabsTrigger>
            <TabsTrigger value="invites">Pending invites ({invitations.length})</TabsTrigger>
          </TabsList>

          {/* ── Members tab ───────────────────────────────────── */}
          <TabsContent value="members" className="mt-2">
            {loading ? (
              <p className="py-4 text-sm text-muted-foreground">Loading…</p>
            ) : loadError ? (
              <p className="py-4 text-sm text-destructive">{loadError}</p>
            ) : members.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">No members yet.</p>
            ) : (
              <ul className="flex max-h-80 flex-col divide-y overflow-y-auto rounded border">
                {members.map((m) => {
                  const initials = initialsFor(m.name, m.email)
                  const added = formatRelativePast(m.addedAt)
                  const isSelf = m.userId === currentUserId
                  const showRemove = isOwner
                  return (
                    <li key={m.userId} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <Avatar>
                        <AvatarFallback>{initials}</AvatarFallback>
                      </Avatar>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-center gap-2 truncate font-medium">
                          {m.name || m.email || m.userId}
                          {isSelf && <span className="text-xs text-muted-foreground">(you)</span>}
                        </span>
                        {m.email && m.name && (
                          <span className="truncate text-xs text-muted-foreground">{m.email}</span>
                        )}
                      </div>
                      <Badge
                        variant={m.role === 'owner' ? 'default' : 'secondary'}
                        className="capitalize"
                      >
                        {m.role}
                      </Badge>
                      {added && (
                        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                          added {added}
                        </span>
                      )}
                      {showRemove && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={`Remove ${m.name ?? m.email ?? m.userId}`}
                          disabled={pendingId === m.userId}
                          onClick={() => setConfirmRemove(m)}
                          className={cn('shrink-0', pendingId === m.userId && 'opacity-60')}
                        >
                          <XIcon />
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </TabsContent>

          {/* ── Invites tab ───────────────────────────────────── */}
          <TabsContent value="invites" className="mt-2">
            {loading ? (
              <p className="py-4 text-sm text-muted-foreground">Loading…</p>
            ) : loadError ? (
              <p className="py-4 text-sm text-destructive">{loadError}</p>
            ) : invitations.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">No pending invitations.</p>
            ) : (
              <ul className="flex max-h-80 flex-col divide-y overflow-y-auto rounded border">
                {invitations.map((inv) => {
                  const expires = formatRelativeFuture(inv.expiresAt)
                  const inviterMember = members.find((m) => m.userId === inv.invitedBy)
                  const inviter = inviterMember?.name ?? inviterMember?.email ?? 'someone'
                  const busy = pendingId === inv.token
                  return (
                    <li key={inv.token} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <Avatar>
                        <AvatarFallback>{initialsFor(null, inv.email)}</AvatarFallback>
                      </Avatar>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{inv.email}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          Invited by {inviter} · expires {expires}
                        </span>
                      </div>
                      <Badge variant="secondary" className="capitalize">
                        {inv.role}
                      </Badge>
                      {isOwner && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void resendInvite(inv)}
                          >
                            Resend
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void revokeInvite(inv)}
                            title="Revoke this invitation"
                          >
                            Revoke
                          </Button>
                        </>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </TabsContent>
        </Tabs>

        {/* ── Owner-only add-member footer ────────────────────── */}
        {isOwner && (
          <form
            onSubmit={submitAdd}
            className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center"
          >
            <Input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="teammate@example.com"
              disabled={adding}
              autoComplete="email"
              aria-label="Invite by email"
              className="sm:flex-1"
            />
            <Button
              type="submit"
              disabled={adding || newEmail.trim() === '' || !EMAIL_RE.test(newEmail.trim())}
            >
              {adding ? 'Adding…' : 'Add member'}
            </Button>
          </form>
        )}

        {/* ── Confirm-remove inline modal ─────────────────────── */}
        {confirmRemove && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            role="dialog"
            aria-modal="true"
          >
            <div className="w-full max-w-sm rounded-lg border bg-background p-6 shadow-lg">
              <h2 className="text-lg font-semibold">
                Remove {confirmRemove.name ?? confirmRemove.email ?? 'member'}?
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                They will lose access to this arc and its sessions. This can be undone by
                re-inviting them.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setConfirmRemove(null)}
                  disabled={pendingId === confirmRemove.userId}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void performRemove(confirmRemove)}
                  disabled={pendingId === confirmRemove.userId}
                >
                  {pendingId === confirmRemove.userId ? 'Removing…' : 'Remove'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
