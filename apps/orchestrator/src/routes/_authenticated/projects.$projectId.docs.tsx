// TODO(GH#27 p5a): wire 'Docs' entry into project navigation when nav component lands

/**
 * /projects/:projectId/docs — left-pane file tree + right-pane BlockNote
 * editor over the project's docs worktree (GH#27 P1.6 WU-C).
 *
 * Data flow:
 *   - GET /api/projects/:projectId/docs-files → file list (proxied from
 *     the gateway by `apps/orchestrator/src/api/index.ts`).
 *   - 200 → render tree.
 *   - 404 (`project_not_configured`) → "Docs not configured" placeholder
 *     (P1.7 will swap this for a configuration modal).
 *   - 503 (`gateway_unavailable`) → retry chip; do NOT render an empty
 *     tree (would falsely imply "no docs exist").
 *
 * The selected `relPath` is local component state. Changing files swaps
 * the right-pane editor's `key`, fully unmounting the collab stack.
 */

import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { DocsEditor } from '~/components/docs/DocsEditor'
import { type DocsFile, DocsFileTree } from '~/components/docs/DocsFileTree'
import { Button } from '~/components/ui/button'

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

function ProjectDocsPage() {
  const { projectId } = Route.useParams()
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [selectedRelPath, setSelectedRelPath] = useState<string | null>(null)

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

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="flex h-full min-h-0 w-full">
      <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r">
        <div className="border-b px-3 py-2 font-medium text-sm">Docs</div>
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
          <div className="p-3 text-muted-foreground text-sm">
            Docs not configured for this project.
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
          />
        )}
      </aside>
      <main className="min-w-0 flex-1">
        {selectedRelPath ? (
          <DocsEditor projectId={projectId} relPath={selectedRelPath} />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            Select a file
          </div>
        )}
      </main>
    </div>
  )
}
