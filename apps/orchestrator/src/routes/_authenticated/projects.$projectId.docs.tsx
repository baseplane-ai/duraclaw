// TODO(GH#27 p5a): wire 'Docs' entry into project navigation when nav component lands

/**
 * /projects/:projectId/docs — left-pane file tree + right-pane BlockNote
 * editor over the project's docs worktree (GH#27 P1.6 WU-C, P1.7 WU-A).
 *
 * Data flow:
 *   - GET /api/projects/:projectId/docs-files → file list (proxied from
 *     the gateway by `apps/orchestrator/src/api/index.ts`).
 *   - 200 → render tree.
 *   - 404 (`project_not_configured`) → open DocsWorktreeSetup modal
 *     (`reason='first-run'`).
 *   - 503 (`gateway_unavailable`) → retry chip; do NOT render an empty
 *     tree (would falsely imply "no docs exist").
 *
 *   - GET /api/docs-runners/:projectId/health (added in WU-B) → if
 *     `config_present === false`, render a ConfigMissingBanner above the
 *     file tree. Until WU-B ships, this fetch silently swallows 404 so
 *     the banner stays hidden.
 *
 * Awareness signals from the docs Y.Doc bubble up via DocsEditor's
 * onAwarenessSignal callback:
 *   - `setup-required` → re-open the DocsWorktreeSetup modal.
 *   - `tombstone-pending` → mark the relPath as tombstoned (strikethrough).
 *   - `tombstone-cancelled` → clear the strikethrough.
 *
 * Caveat: awareness signals only fire while DocsEditor is mounted (i.e.
 * a file is selected). If a `setup-required` is fired before any file
 * is selected, the 404 fallback covers first-run; for live re-config
 * during a session this is acceptable for v1.
 * TODO(GH#27 P1.8): listen for awareness on the bare project room too,
 * so setup-required / tombstone signals reach the route even with no
 * file selected.
 */

import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { ConfigMissingBanner } from '~/components/docs/ConfigMissingBanner'
import type { ConnectedPeer } from '~/components/docs/ConnectedPeersChip'
import { ConnectedPeersChip } from '~/components/docs/ConnectedPeersChip'
import { type DocsAwarenessSignal, DocsEditor } from '~/components/docs/DocsEditor'
import { type DocsFile, type DocsFileState, DocsFileTree } from '~/components/docs/DocsFileTree'
import { DocsWorktreeSetup } from '~/components/docs/DocsWorktreeSetup'
import { Button } from '~/components/ui/button'

/** Poll cadence for the docs-runner health proxy (P1.7 WU-B). */
const HEALTH_POLL_MS = 5_000

export const Route = createFileRoute('/_authenticated/projects/$projectId/docs')({
  component: ProjectDocsPage,
})

interface DocsFilesResponse {
  files: DocsFile[]
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ok'; files: DocsFile[] }
  | { kind: 'unavailable' } // 503
  | { kind: 'not-configured' } // 404
  | { kind: 'error'; message: string }

interface DocsRunnerHealthFileEntry {
  path: string
  state: DocsFileState
  last_sync_ts?: number
  error_count?: number
}

interface DocsRunnerHealth {
  config_present?: boolean
  per_file?: DocsRunnerHealthFileEntry[]
}

const BANNER_DISMISS_KEY_PREFIX = 'docs-config-banner-dismissed-'

function ProjectDocsPage() {
  const { projectId } = Route.useParams()
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [selectedRelPath, setSelectedRelPath] = useState<string | null>(null)
  const [peers, setPeers] = useState<ConnectedPeer[]>([])
  const [tombstoned, setTombstoned] = useState<Set<string>>(new Set())
  const [setupOpen, setSetupOpen] = useState<{ reason: 'first-run' | 'setup-required' } | null>(
    null,
  )
  const [configMissing, setConfigMissing] = useState(false)
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [fileStates, setFileStates] = useState<Map<string, DocsFileState>>(new Map())

  // Re-read the per-project banner-dismissed flag whenever the project
  // changes. Falls back to `false` when localStorage is unavailable.
  useEffect(() => {
    try {
      const flag = window.localStorage.getItem(BANNER_DISMISS_KEY_PREFIX + projectId)
      setBannerDismissed(flag === '1')
    } catch {
      setBannerDismissed(false)
    }
  }, [projectId])

  const dismissBanner = useCallback(() => {
    setBannerDismissed(true)
    try {
      window.localStorage.setItem(BANNER_DISMISS_KEY_PREFIX + projectId, '1')
    } catch {
      /* localStorage may be disabled; in-memory state still hides it */
    }
  }, [projectId])

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    let resp: Response
    try {
      resp = await fetch(`/api/projects/${projectId}/docs-files`, {
        credentials: 'include',
      })
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      })
      return
    }

    if (resp.status === 503) {
      setState({ kind: 'unavailable' })
      return
    }
    if (resp.status === 404) {
      setState({ kind: 'not-configured' })
      // First-run path: open the setup modal automatically.
      setSetupOpen({ reason: 'first-run' })
      return
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      setState({ kind: 'error', message: `HTTP ${resp.status}: ${text}` })
      return
    }
    try {
      const body = (await resp.json()) as DocsFilesResponse
      setState({ kind: 'ok', files: body.files ?? [] })
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Bad response',
      })
    }
  }, [projectId])

  // Health probe (WU-B endpoint). Drives the ConfigMissingBanner via
  // `config_present` and the per-file state dots via `per_file`. On any
  // non-200 (404 = no metadata, 502 = runner down, 503 = gateway down)
  // we clear the live state — the banner stays hidden and the dots
  // disappear. The route falls back to the basic file tree.
  const loadHealth = useCallback(async () => {
    try {
      const resp = await fetch(`/api/docs-runners/${projectId}/health`, {
        credentials: 'include',
      })
      if (!resp.ok) {
        setConfigMissing(false)
        setFileStates(new Map())
        return
      }
      const body = (await resp.json().catch(() => ({}))) as DocsRunnerHealth
      setConfigMissing(body.config_present === false)
      const next = new Map<string, DocsFileState>()
      for (const entry of body.per_file ?? []) {
        if (entry?.path && entry.state) next.set(entry.path, entry.state)
      }
      setFileStates(next)
    } catch {
      setConfigMissing(false)
      setFileStates(new Map())
    }
  }, [projectId])

  useEffect(() => {
    void load()
    void loadHealth()
    // Per spec: poll every 5 s while the route is mounted. Cleanup on
    // unmount so the timer doesn't leak across navigations.
    const timer = setInterval(() => {
      void loadHealth()
    }, HEALTH_POLL_MS)
    return () => clearInterval(timer)
  }, [load, loadHealth])

  const onAwarenessSignal = useCallback(
    (signal: DocsAwarenessSignal) => {
      if (signal.kind === 'setup-required') {
        setSetupOpen({ reason: 'setup-required' })
        return
      }
      if (signal.kind === 'tombstone-pending') {
        const path = signal.relPath ?? selectedRelPath
        if (!path) return
        setTombstoned((prev) => {
          if (prev.has(path)) return prev
          const next = new Set(prev)
          next.add(path)
          return next
        })
        return
      }
      if (signal.kind === 'tombstone-cancelled') {
        const path = signal.relPath ?? selectedRelPath
        if (!path) return
        setTombstoned((prev) => {
          if (!prev.has(path)) return prev
          const next = new Set(prev)
          next.delete(path)
          return next
        })
        return
      }
    },
    [selectedRelPath],
  )

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex items-center gap-3 border-b px-3 py-2">
        <div className="font-medium text-sm">Docs</div>
        <div className="flex-1" />
        <ConnectedPeersChip peers={peers} />
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r">
          {configMissing && !bannerDismissed && (
            <ConfigMissingBanner projectId={projectId} onDismiss={dismissBanner} />
          )}
          {state.kind === 'loading' && (
            <div className="p-3 text-muted-foreground text-sm">Loading…</div>
          )}
          {state.kind === 'unavailable' && (
            <div className="flex flex-col gap-2 p-3 text-sm">
              <span className="text-muted-foreground">Gateway unavailable</span>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          )}
          {state.kind === 'not-configured' && (
            <div className="flex flex-col gap-2 p-3 text-sm">
              <span className="text-muted-foreground">Docs not configured for this project.</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSetupOpen({ reason: 'first-run' })}
              >
                Configure
              </Button>
            </div>
          )}
          {state.kind === 'error' && (
            <div className="flex flex-col gap-2 p-3 text-sm">
              <span className="text-destructive">Failed to load docs.</span>
              <span className="text-muted-foreground text-xs">{state.message}</span>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          )}
          {state.kind === 'ok' && (
            <DocsFileTree
              files={state.files}
              selected={selectedRelPath}
              onSelect={setSelectedRelPath}
              tombstoned={tombstoned}
              fileStates={fileStates}
            />
          )}
        </aside>
        <main className="min-w-0 flex-1">
          {selectedRelPath ? (
            <DocsEditor
              projectId={projectId}
              relPath={selectedRelPath}
              onPeersChange={setPeers}
              onAwarenessSignal={onAwarenessSignal}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
              Select a file
            </div>
          )}
        </main>
      </div>

      <DocsWorktreeSetup
        projectId={projectId}
        isOpen={setupOpen !== null}
        reason={setupOpen?.reason ?? 'first-run'}
        onClose={() => setSetupOpen(null)}
        onConfigured={() => {
          // PATCH succeeded; reload the file list and the health probe.
          void load()
          void loadHealth()
        }}
      />
    </div>
  )
}
