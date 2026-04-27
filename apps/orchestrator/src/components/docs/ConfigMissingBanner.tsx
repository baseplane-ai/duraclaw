/**
 * ConfigMissingBanner (GH#27 P1.7 WU-A)
 *
 * Surfaced in the docs route when `GET /api/docs-runners/:projectId/health`
 * reports the runner has logged `config_missing` (no `duraclaw-docs.yaml`
 * in the worktree). The banner CTA is a copyable shell snippet that the
 * user runs on the VPS to bootstrap the config; dismissable per-session
 * via localStorage so it doesn't shout on every reload.
 *
 * The dismissal key is namespaced by projectId so two projects don't
 * cross-mute each other.
 */

import { AlertTriangle, Copy, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '~/components/ui/button'

export interface ConfigMissingBannerProps {
  projectId: string
  onDismiss: () => void
}

export function ConfigMissingBanner({ projectId, onDismiss }: ConfigMissingBannerProps) {
  const [copied, setCopied] = useState(false)
  const snippet = `docs-runner init ${projectId}`

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Silent — copy is a nice-to-have; user can still select/copy
      // the snippet manually from the rendered code block.
    }
  }

  return (
    <div
      role="alert"
      data-testid="config-missing-banner"
      className="flex flex-col gap-2 border border-amber-300 bg-amber-50 p-3 text-amber-900 text-sm dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="flex-1">
          <div className="font-medium">No duraclaw-docs.yaml found</div>
          <div className="text-amber-800 text-xs dark:text-amber-300">
            Run{' '}
            <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/40">docs-runner init</code>{' '}
            in the docs worktree to create one.
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          data-testid="config-missing-banner-dismiss"
          className="shrink-0 rounded p-0.5 hover:bg-amber-100 dark:hover:bg-amber-900/40"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded border border-amber-200 bg-amber-100/60 px-2 py-1 font-mono text-xs dark:border-amber-800 dark:bg-amber-900/30">
          {snippet}
        </code>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onCopy}
          data-testid="config-missing-banner-copy"
        >
          <Copy className="mr-1 size-3" />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}
