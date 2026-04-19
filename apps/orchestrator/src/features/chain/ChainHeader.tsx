/**
 * ChainHeader — top strip for /chain/:issueNumber.
 *
 * P1 stub: renders `#<issue> <title?>` plus a workspace line. Title
 * defaults to whatever the first session carries; GH API wiring and
 * worktree reservation badge are P2 concerns.
 */

interface ChainHeaderProps {
  issueNumber: number
  title?: string
  workspace?: string
}

export function ChainHeader({ issueNumber, title, workspace }: ChainHeaderProps) {
  return (
    <div className="border-b pb-3 mb-4">
      <h2 className="text-lg font-semibold">
        #{issueNumber}
        {title ? ` ${title}` : ''}
      </h2>
      <p className="text-xs text-muted-foreground mt-1">workspace: {workspace ?? '(unknown)'}</p>
    </div>
  )
}
