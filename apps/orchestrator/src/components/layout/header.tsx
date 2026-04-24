import { useEffect, useState } from 'react'
import { SidebarTriggerWithUnread } from '~/components/layout/sidebar-trigger-with-unread'
import { cn } from '~/lib/utils'

type HeaderProps = React.HTMLAttributes<HTMLElement> & {
  fixed?: boolean
  /**
   * When true, render children flush with no extra padding / gap — used
   * so `TabBar` can occupy the header row edge-to-edge. Default (false)
   * keeps the old inline layout for routes that just pass breadcrumbs
   * or inline controls.
   */
  flush?: boolean
  ref?: React.Ref<HTMLElement>
}

export function Header({ className, fixed, flush, children, ...props }: HeaderProps) {
  const [offset, setOffset] = useState(0)

  useEffect(() => {
    const onScroll = () => {
      setOffset(document.body.scrollTop || document.documentElement.scrollTop)
    }

    // Add scroll listener to the body
    document.addEventListener('scroll', onScroll, { passive: true })

    // Clean up the event listener on unmount
    return () => document.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      className={cn(
        'z-50 h-12',
        fixed && 'header-fixed peer/header sticky top-0 w-[inherit]',
        offset > 10 && fixed ? 'shadow' : 'shadow-none',
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          'relative flex h-full items-stretch',
          flush ? 'gap-0' : 'gap-3 p-2 sm:gap-4 items-center',
          offset > 10 &&
            fixed &&
            'after:absolute after:inset-0 after:-z-10 after:bg-background/20 after:backdrop-blur-lg',
        )}
      >
        <div className={cn('flex items-center', flush && 'px-1 border-r shrink-0')}>
          <SidebarTriggerWithUnread variant="outline" className="max-md:scale-110" />
        </div>
        {children}
      </div>
    </header>
  )
}
