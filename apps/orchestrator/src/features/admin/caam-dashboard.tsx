import type { CaamProfileStatus, CaamStatus } from '@duraclaw/shared-types'
import { useEffect, useRef, useState } from 'react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { cn } from '~/lib/utils'

const POLL_MS = 5000
const TICK_MS = 1000
const CAAM_STATUS_URL = '/api/admin/caam/status'

/**
 * Module-scope fetch helper shared by both the polling effect and the
 * manual refetch button. Throws on non-OK responses or malformed payload;
 * the caller is responsible for try/catch + state reduction.
 */
async function fetchStatus(signal?: AbortSignal): Promise<CaamStatus> {
  const resp = await fetch(CAAM_STATUS_URL, { credentials: 'include', signal })
  if (!resp.ok) {
    // 200 + caam_configured:false is the degraded-mode path. Anything
    // non-OK is an actual failure (5xx, 401/403) — surface it.
    const body = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${body || resp.statusText}`)
  }
  const body = (await resp.json()) as unknown
  if (!isCaamStatus(body)) {
    throw new Error('Malformed response payload')
  }
  return body
}

const RELATIVE_FORMATTER =
  typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl
    ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
    : null

function formatRelative(targetMs: number, nowMs: number): string {
  const diffMs = targetMs - nowMs
  const absSeconds = Math.round(Math.abs(diffMs) / 1000)
  // Choose a coarse unit so the label reads naturally.
  let value: number
  let unit: Intl.RelativeTimeFormatUnit
  if (absSeconds < 60) {
    value = Math.round(diffMs / 1000)
    unit = 'second'
  } else if (absSeconds < 3600) {
    value = Math.round(diffMs / 60_000)
    unit = 'minute'
  } else if (absSeconds < 86400) {
    value = Math.round(diffMs / 3_600_000)
    unit = 'hour'
  } else {
    value = Math.round(diffMs / 86_400_000)
    unit = 'day'
  }
  if (RELATIVE_FORMATTER) {
    return RELATIVE_FORMATTER.format(value, unit)
  }
  // Fallback when Intl.RelativeTimeFormat is unavailable.
  const sign = value < 0 ? '' : 'in '
  const suffix = value < 0 ? ' ago' : ''
  return `${sign}${Math.abs(value)} ${unit}${Math.abs(value) === 1 ? '' : 's'}${suffix}`
}

function formatCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return 'ready'
  const totalSeconds = Math.ceil(remainingMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }
  return `${seconds}s`
}

function healthTone(status: string): string {
  const s = status.toLowerCase()
  if (s === 'ok' || s === 'healthy') {
    return 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
  }
  if (s === 'cooldown' || s === 'warn' || s === 'warning') {
    return 'bg-amber-500/15 text-amber-700 border-amber-500/30'
  }
  if (s === 'error' || s === 'failed' || s === 'unhealthy') {
    return 'bg-destructive/15 text-destructive border-destructive/30'
  }
  return 'bg-muted text-muted-foreground border-border'
}

interface FetchState {
  data: CaamStatus | null
  error: Error | null
  isFetching: boolean
}

function isCaamStatus(value: unknown): value is CaamStatus {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.caam_configured === 'boolean' &&
    Array.isArray(v.profiles) &&
    Array.isArray(v.warnings) &&
    typeof v.fetched_at_ms === 'number'
  )
}

export function CaamDashboard() {
  const [state, setState] = useState<FetchState>({
    data: null,
    error: null,
    isFetching: false,
  })
  const [now, setNow] = useState<number>(() => Date.now())
  // Overlap guard for the polling timer: if a fetch takes longer than
  // POLL_MS the next interval tick must skip rather than stack a second
  // in-flight request. The manual `refetch` button is intentionally NOT
  // gated on this — user intent always wins over a scheduled poll.
  const isFetchingRef = useRef(false)

  // Polling fetch — 5s interval. Subsequent refetches don't unmount; we
  // only flip a transient `isFetching` so the footer can pulse.
  useEffect(() => {
    let cancelled = false

    const loadPolled = async () => {
      if (cancelled) return
      if (isFetchingRef.current) return
      isFetchingRef.current = true
      setState((prev) => ({ ...prev, isFetching: true }))
      try {
        const body = await fetchStatus()
        if (cancelled) return
        setState({ data: body, error: null, isFetching: false })
      } catch (err) {
        if (cancelled) return
        setState((prev) => ({
          data: prev.data,
          error: err instanceof Error ? err : new Error(String(err)),
          isFetching: false,
        }))
      } finally {
        isFetchingRef.current = false
      }
    }

    void loadPolled()
    const handle = window.setInterval(loadPolled, POLL_MS)
    const onFocus = () => {
      void loadPolled()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(handle)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // 1s countdown tick — independent of the 5s poll so cooldowns animate
  // smoothly without thrashing the network.
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(handle)
  }, [])

  const refetch = () => {
    // Manual refetch is NOT gated on isFetchingRef — a user click should
    // always trigger a fresh request even if a scheduled poll is mid-flight.
    setState((prev) => ({ ...prev, isFetching: true, error: null }))
    void fetchStatus()
      .then((body) => {
        setState({ data: body, error: null, isFetching: false })
      })
      .catch((err) => {
        setState((prev) => ({
          data: prev.data,
          error: err instanceof Error ? err : new Error(String(err)),
          isFetching: false,
        }))
      })
  }

  const { data, error, isFetching } = state
  const isFirstLoad = !data && !error

  if (isFirstLoad) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Loading caam status…</p>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="space-y-4">
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">Failed to load caam status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{error.message}</p>
            <Button onClick={refetch} size="sm" variant="outline">
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // From here on, `data` is non-null (handled above).
  if (!data) return null

  const activeEntry =
    data.profiles.find((p) => p.active) ??
    data.profiles.find((p) => p.name === data.active_profile) ??
    null

  return (
    <div className="space-y-4">
      {!data.caam_configured ? (
        <Card className="border-muted">
          <CardHeader>
            <CardTitle className="text-base text-muted-foreground">caam not installed</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              caam is not installed on this host. Rotation is disabled; sessions run against
              ~/.claude directly.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">Active profile</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center gap-3">
              <span className="text-2xl font-semibold tabular-nums">
                {data.active_profile ?? '—'}
              </span>
              {activeEntry && (
                <Badge className={cn('border', healthTone(activeEntry.health.status))}>
                  {activeEntry.health.status}
                  {activeEntry.health.error_count > 0 && (
                    <span className="ml-1 opacity-75">· {activeEntry.health.error_count} err</span>
                  )}
                </Badge>
              )}
            </CardContent>
          </Card>

          {data.profiles.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.profiles.map((profile) => (
                <ProfileCard key={profile.name} profile={profile} now={now} />
              ))}
            </div>
          )}
        </>
      )}

      {data.warnings.length > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="text-sm text-amber-700">Warnings</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-inside list-disc space-y-1 text-sm text-amber-700">
              {data.warnings.map((w, i) => (
                // Warnings are free-form strings; index suffix disambiguates dupes.
                // biome-ignore lint/suspicious/noArrayIndexKey: stable per render
                <li key={`${w}-${i}`}>{w}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm text-muted-foreground">Last rotation</CardTitle>
        </CardHeader>
        <CardContent>
          {data.last_rotation ? (
            <p className="text-sm">
              <span className="font-medium">{data.last_rotation.from}</span>
              <span className="mx-1 text-muted-foreground">→</span>
              <span className="font-medium">{data.last_rotation.to}</span>
              <span className="mx-2 text-muted-foreground">·</span>
              <span className="text-muted-foreground">
                {formatRelative(data.last_rotation.at_ms, now)}
              </span>
              <span className="mx-2 text-muted-foreground">·</span>
              <span className="font-mono text-xs text-muted-foreground">
                session {data.last_rotation.session_id.slice(0, 8)}
              </span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No rotations observed yet in retained session artifacts.
            </p>
          )}
        </CardContent>
      </Card>

      {error && data && (
        <p className="text-xs text-destructive">Last refresh failed: {error.message}</p>
      )}

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {isFetching && (
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500"
          />
        )}
        <span>Refreshed {formatRelative(data.fetched_at_ms, now)}</span>
      </div>
    </div>
  )
}

function ProfileCard({ profile, now }: { profile: CaamProfileStatus; now: number }) {
  const remainingMs =
    typeof profile.cooldown_until === 'number' ? profile.cooldown_until - now : null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span>{profile.name}</span>
          {profile.active && (
            <Badge variant="default" className="text-[10px]">
              Active
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <Badge className={cn('border', healthTone(profile.health.status))}>
            {profile.health.status}
          </Badge>
          <span className="text-muted-foreground">
            {profile.health.error_count} error{profile.health.error_count === 1 ? '' : 's'}
          </span>
        </div>
        {remainingMs !== null && (
          <div className="text-xs text-muted-foreground">
            Cooldown:{' '}
            <span className="font-mono tabular-nums text-foreground">
              {formatCountdown(remainingMs)}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
