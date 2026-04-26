/**
 * GH#102 / spec 102-sdk-peelback B12: surfaces SDK `api_retry` events
 * (translated by the runner from `SDKAPIRetryMessage`). Driven by the
 * transient `useApiRetryStore`; auto-clears on the next non-retry event
 * or after 30s.
 */

import { RotateCw } from 'lucide-react'
import { useApiRetryStore } from '~/stores/api-retry-store'

export function ApiRetryBanner() {
  const retry = useApiRetryStore((s) => s.current)
  if (!retry) return null
  return (
    <div className="flex items-center gap-2 border-warning border-b bg-warning/20 px-4 py-2 text-sm">
      <RotateCw className="size-4 animate-spin" />
      <span>
        Retrying request (attempt {retry.attempt} of {retry.max_retries},{' '}
        {Math.round(retry.retry_delay_ms / 1000)}s)…
      </span>
      <span className="text-muted-foreground text-xs">{retry.error}</span>
    </div>
  )
}
