import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'

export interface CaamProfile {
  name: string
  active: boolean
  system: boolean
  plan: string | null
  util_7d_pct: number | null
  resets_at: string | null
  cooldown_until: string | null
}

interface ProfilesPayload {
  profiles: CaamProfile[]
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

function fmtPct(value: number | null): string {
  if (value == null) return '—'
  return `${value.toFixed(1)}%`
}

export function CaamDashboard() {
  const [profiles, setProfiles] = useState<CaamProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activating, setActivating] = useState<string | null>(null)

  const fetchProfiles = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await fetch('/api/admin/caam/profiles', { credentials: 'include' })
      if (!resp.ok) {
        const msg = `Failed to load profiles (HTTP ${resp.status})`
        setProfiles([])
        setError(msg)
        toast.error(msg)
        return
      }
      const data = (await resp.json()) as ProfilesPayload
      setProfiles(data.profiles ?? [])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setProfiles([])
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  const onActivate = useCallback(async (name: string) => {
    setActivating(name)
    try {
      const resp = await fetch('/api/admin/caam/activate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: name }),
      })
      if (!resp.ok) {
        const msg = `Failed to activate ${name} (HTTP ${resp.status})`
        setError(msg)
        toast.error(msg)
        return
      }
      const data = (await resp.json()) as ProfilesPayload
      setProfiles(data.profiles ?? [])
      setError(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      toast.error(msg)
    } finally {
      setActivating(null)
    }
  }, [])

  useEffect(() => {
    void fetchProfiles()
  }, [fetchProfiles])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Active Claude auth profiles, last 7d utilization, and cooldown state.
        </p>
        <Button onClick={() => void fetchProfiles()} disabled={loading} variant="outline">
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Active</TableHead>
            <TableHead>Utilization (7d)</TableHead>
            <TableHead>Resets at</TableHead>
            <TableHead>Cooldown until</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {profiles.map((p) => (
            <TableRow key={p.name}>
              <TableCell className="font-medium">{p.name}</TableCell>
              <TableCell>
                {p.active ? (
                  <Badge variant="default">Active</Badge>
                ) : (
                  <Badge variant="secondary">Idle</Badge>
                )}
              </TableCell>
              <TableCell>{fmtPct(p.util_7d_pct)}</TableCell>
              <TableCell>{fmtTime(p.resets_at)}</TableCell>
              <TableCell>{fmtTime(p.cooldown_until)}</TableCell>
              <TableCell className="text-right">
                <Button
                  onClick={() => void onActivate(p.name)}
                  disabled={p.active || activating !== null}
                  size="sm"
                  variant="outline"
                >
                  {activating === p.name ? 'Activating…' : 'Activate'}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
