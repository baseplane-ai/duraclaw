/**
 * TransferOwnershipDialog (GH#122 P4 / B-UI-4 + B-UI-5)
 *
 * Opens a user-picker dialog for transferring project ownership. Picker
 * source depends on caller role:
 *   - admin → `authClient.admin.listUsers({ query: { limit: 100 } })`
 *     (Better Auth admin plugin, same call as `admin.users.tsx`).
 *   - non-admin owner → `GET /api/users/picker` (lightweight endpoint
 *     introduced in P3b, returns `[{ id, displayName, email }]`).
 *
 * On submit POSTs `/api/projects/:projectId/transfer` with
 * `{ newOwnerUserId }`. Server-side broadcast updates the
 * projectsCollection optimistically — no manual refetch.
 */

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { authClient } from '~/lib/auth-client'
import { apiUrl } from '~/lib/platform'

interface PickerUser {
  id: string
  displayName: string | null
  email: string
}

export interface TransferOwnershipDialogProps {
  projectId: string
  projectName: string
  currentOwnerId: string | null
  /** 'admin' uses the admin listUsers endpoint; anything else uses the picker. */
  currentUserRole: string
  onClose: () => void
}

export function TransferOwnershipDialog({
  projectId,
  projectName,
  currentOwnerId,
  currentUserRole,
  onClose,
}: TransferOwnershipDialogProps) {
  const [users, setUsers] = useState<PickerUser[]>([])
  const [selected, setSelected] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        if (currentUserRole === 'admin') {
          const { data, error } = await authClient.admin.listUsers({
            query: { limit: 100 },
          })
          if (cancelled) return
          if (error) {
            setLoadError(error.message ?? 'Failed to load users')
            setUsers([])
            return
          }
          const list = (
            (data?.users ?? []) as Array<{
              id: string
              name?: string | null
              email: string
            }>
          ).map((u) => ({
            id: u.id,
            displayName: u.name ?? null,
            email: u.email,
          })) as PickerUser[]
          setUsers(list)
        } else {
          const resp = await fetch(apiUrl('/api/users/picker'), {
            credentials: 'include',
          })
          if (cancelled) return
          if (!resp.ok) {
            setLoadError(`Failed to load users (${resp.status})`)
            setUsers([])
            return
          }
          const list = (await resp.json()) as PickerUser[]
          setUsers(list)
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [currentUserRole])

  const candidates = users.filter((u) => u.id !== currentOwnerId)

  const submit = async () => {
    if (!selected) return
    setSubmitting(true)
    try {
      const resp = await fetch(apiUrl(`/api/projects/${projectId}/transfer`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ newOwnerUserId: selected }),
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        toast.error(`Transfer failed (${resp.status}) ${body}`)
      } else {
        toast.success(`Transferred ${projectName}`)
        onClose()
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transfer ownership of {projectName}</DialogTitle>
        </DialogHeader>
        {loadError && <p className="text-sm text-destructive">{loadError}</p>}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading users…</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No other users available.</p>
        ) : (
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Pick a user…" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.displayName ?? u.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || !selected}>
            {submitting ? 'Transferring…' : 'Transfer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
