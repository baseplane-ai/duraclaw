/**
 * DocsWorktreeSetup (GH#27 P1.7 WU-A, B19)
 *
 * First-run modal that prompts the user to configure
 * `projectMetadata.docsWorktreePath` for a project. Triggered when:
 *   - GET /api/projects/:projectId/docs-files returned 404
 *     `project_not_configured` (`reason='first-run'`).
 *   - The DO emitted `{ kind: 'setup-required' }` (B12) while a doc
 *     was open (`reason='setup-required'`).
 *
 * The body explains why a separate worktree is needed, surfaces a
 * copyable `git worktree add ../<slug>-docs main` snippet, and accepts
 * the resulting absolute path. Submit PATCHes
 * `/api/projects/:projectId { docsWorktreePath }`.
 */

import { Copy, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'

export interface DocsWorktreeSetupProps {
  projectId: string
  projectName?: string
  isOpen: boolean
  reason: 'first-run' | 'setup-required'
  onClose: () => void
  onConfigured: () => void
}

/**
 * `name` → `name-docs` slug-ish. Lowercased, non-alnum collapsed to `-`,
 * leading/trailing dashes trimmed; falls back to "project" so we always
 * produce a usable suggestion.
 */
function slugify(name: string | undefined): string {
  if (!name) return 'project'
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'project'
}

export function DocsWorktreeSetup({
  projectId,
  projectName,
  isOpen,
  reason,
  onClose,
  onConfigured,
}: DocsWorktreeSetupProps) {
  const slug = slugify(projectName ?? projectId)
  const snippet = `git worktree add ../${slug}-docs main`
  const defaultPath = `/path/to/${slug}-docs`

  const [path, setPath] = useState(defaultPath)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [snippetCopied, setSnippetCopied] = useState(false)

  // Reset form whenever the modal re-opens. Prevents a stale error /
  // stale custom path from a previous attempt leaking into the next one.
  useEffect(() => {
    if (isOpen) {
      setPath(defaultPath)
      setError(null)
      setSubmitting(false)
    }
  }, [isOpen, defaultPath])

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet)
      setSnippetCopied(true)
      setTimeout(() => setSnippetCopied(false), 2000)
    } catch {
      /* clipboard may be unavailable; user can copy manually */
    }
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting) return
    const trimmed = path.trim()
    if (!trimmed) {
      setError('Path is required')
      return
    }
    if (!trimmed.startsWith('/')) {
      setError('Path must be absolute (start with /)')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const resp = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docsWorktreePath: trimmed }),
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        setError(`HTTP ${resp.status}${text ? `: ${text}` : ''}`)
        setSubmitting(false)
        return
      }
      setSubmitting(false)
      onConfigured()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="docs-worktree-setup">
        <DialogHeader>
          <DialogTitle>Configure docs worktree</DialogTitle>
          <DialogDescription>
            {reason === 'setup-required'
              ? 'The docs runner needs a worktree path before it can sync this project.'
              : 'Duraclaw needs a dedicated git worktree pinned to main for this project’s documentation. This keeps your docs CRDT-synced regardless of which feature branch you’re on.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="docs-worktree-snippet">1. Create the worktree</Label>
            <div className="flex items-center gap-2">
              <code
                id="docs-worktree-snippet"
                className="flex-1 truncate rounded border bg-muted px-2 py-1.5 font-mono text-xs"
                data-testid="docs-worktree-snippet"
              >
                {snippet}
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onCopy}
                data-testid="docs-worktree-copy"
              >
                <Copy className="mr-1 size-3" />
                {snippetCopied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="docs-worktree-path">2. Absolute path to the worktree</Label>
            <Input
              id="docs-worktree-path"
              data-testid="docs-worktree-path"
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/data/projects/myproject-docs"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {error && (
            <div
              role="alert"
              data-testid="docs-worktree-error"
              className="text-destructive text-sm"
            >
              {error}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
              data-testid="docs-worktree-cancel"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting} data-testid="docs-worktree-submit">
              {submitting && <Loader2 className="mr-1 size-3 animate-spin" />}
              Save path
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
