/**
 * session-utils — Shared utilities for session display components.
 *
 * Extracted from SessionListItem so SessionCardList and other
 * components can reuse formatting and status display logic.
 */

export function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function StatusDot({ status, numTurns }: { status: string; numTurns: number }) {
  const isSpawning = status === 'running' && numTurns === 0

  if (isSpawning) {
    return <span className="size-2 shrink-0 rounded-full bg-blue-500 animate-pulse" />
  }

  switch (status) {
    case 'running':
      return <span className="size-2 shrink-0 rounded-full bg-green-500" />
    case 'waiting_gate':
    case 'waiting_input':
    case 'waiting_permission':
      return <span className="size-2 shrink-0 rounded-full bg-yellow-500" />
    case 'aborted':
      return <span className="size-2 shrink-0 rounded-full bg-red-500" />
    default:
      return <span className="size-2 shrink-0 rounded-full border border-gray-400" />
  }
}

export function getPreviewText(session: { summary?: string; prompt?: string }): string | undefined {
  return session.summary || session.prompt || undefined
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`
}

export function getProjectInitials(
  project: string | null | undefined,
  title: string | null | undefined,
): string {
  if (project) return project.slice(0, 2)
  if (title) return title.slice(0, 2)
  return '??'
}
