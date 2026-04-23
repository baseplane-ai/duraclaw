import { Globe, Lock } from 'lucide-react'
import { cn } from '~/lib/utils'

export function VisibilityBadge({
  visibility,
  className,
  showLabel = false,
}: {
  visibility: 'public' | 'private' | undefined
  className?: string
  showLabel?: boolean
}) {
  if (!visibility) return null
  const Icon = visibility === 'public' ? Globe : Lock
  const label = visibility === 'public' ? 'Public' : 'Private'
  return (
    <span
      role="img"
      className={cn('inline-flex items-center gap-1 text-[10px] text-muted-foreground', className)}
      title={label}
      aria-label={label}
    >
      <Icon className="size-3" />
      {showLabel && <span>{label}</span>}
    </span>
  )
}
