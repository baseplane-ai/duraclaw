import { cn } from '~/lib/utils'
import { Button } from './ui'

interface BottomTabsProps {
  pathname: string
  onNavigate: (to: '/' | '/settings') => void
  onOpenSessions: () => void
}

export function BottomTabs({ pathname, onNavigate, onOpenSessions }: BottomTabsProps) {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2 backdrop-blur lg:hidden sm:hidden"
      data-testid="bottom-tabs"
    >
      <div className="mx-auto grid max-w-md grid-cols-3 gap-2">
        <Button
          type="button"
          variant="ghost"
          className={cn(
            'min-h-11 flex-col gap-1 rounded-xl px-2 py-2 text-xs',
            pathname.startsWith('/session/') && 'bg-accent text-accent-foreground',
          )}
          data-testid="bottom-tab-sessions"
          onClick={onOpenSessions}
        >
          <span className="text-sm">≡</span>
          <span>Sessions</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={cn(
            'min-h-11 flex-col gap-1 rounded-xl px-2 py-2 text-xs',
            pathname === '/' && 'bg-accent text-accent-foreground',
          )}
          data-testid="bottom-tab-dashboard"
          onClick={() => onNavigate('/')}
        >
          <span className="text-sm">⌂</span>
          <span>Dashboard</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={cn(
            'min-h-11 flex-col gap-1 rounded-xl px-2 py-2 text-xs',
            pathname === '/settings' && 'bg-accent text-accent-foreground',
          )}
          data-testid="bottom-tab-settings"
          onClick={() => onNavigate('/settings')}
        >
          <span className="text-sm">⚙</span>
          <span>Settings</span>
        </Button>
      </div>
    </nav>
  )
}
