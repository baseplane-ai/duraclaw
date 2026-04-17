import { Outlet } from '@tanstack/react-router'
import { AppSidebar } from '~/components/layout/app-sidebar'
import { SkipToMain } from '~/components/skip-to-main'
import { SwUpdateBanner } from '~/components/sw-update-banner'
import { SidebarInset, SidebarProvider } from '~/components/ui/sidebar'
import { LayoutProvider } from '~/context/layout-provider'
import { SearchProvider } from '~/context/search-provider'
import { getCookie } from '~/lib/cookies'
import { cn } from '~/lib/utils'

type AuthenticatedLayoutProps = {
  children?: React.ReactNode
}

export function AuthenticatedLayout({ children }: AuthenticatedLayoutProps) {
  const defaultOpen = getCookie('sidebar_state') !== 'false'
  return (
    <SearchProvider>
      <LayoutProvider>
        <SidebarProvider defaultOpen={defaultOpen}>
          <SkipToMain />
          <AppSidebar />
          <SidebarInset
            className={cn(
              // Set content container, so we can use container queries
              '@container/content',

              // If layout is fixed, constrain to viewport and prevent overflow.
              // Use dvh (dynamic viewport height) so the layout shrinks when the
              // mobile keyboard opens, keeping the input visible.
              'has-data-[layout=fixed]:h-dvh',
              'has-data-[layout=fixed]:overflow-hidden',

              // If layout is fixed and sidebar is inset,
              // set the height to 100dvh - spacing (total margins) to prevent overflow
              'peer-data-[variant=inset]:has-data-[layout=fixed]:h-[calc(100dvh-(var(--spacing)*4))]',
            )}
          >
            {children ?? <Outlet />}
          </SidebarInset>
        </SidebarProvider>
        <SwUpdateBanner />
      </LayoutProvider>
    </SearchProvider>
  )
}
