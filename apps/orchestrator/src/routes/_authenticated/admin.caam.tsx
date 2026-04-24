import { createFileRoute } from '@tanstack/react-router'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { CaamDashboard } from '~/features/admin/caam-dashboard'
import { useSession } from '~/lib/auth-client'

export const Route = createFileRoute('/_authenticated/admin/caam')({
  component: AdminCaamPage,
})

// Role gate mirrors deploys.tsx — admin.users.tsx is gated only at the
// sidebar entry point, but this page is reachable by direct URL so we
// guard explicitly. TODO: extract a shared <RequireAdmin> wrapper once
// more admin pages exist.
function AdminCaamPage() {
  const { data: session, isPending } = useSession()
  const isAdmin = session?.user?.role === 'admin'

  if (isPending) {
    return (
      <>
        <Header fixed>
          <h1 className="text-lg font-semibold">Auth Rotation</h1>
        </Header>
        <Main>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </Main>
      </>
    )
  }

  if (!isAdmin) {
    return (
      <>
        <Header fixed>
          <h1 className="text-lg font-semibold">Auth Rotation</h1>
        </Header>
        <Main>
          <p className="text-sm text-muted-foreground">Admin access required.</p>
        </Main>
      </>
    )
  }

  return (
    <>
      <Header fixed>
        <h1 className="text-lg font-semibold">Auth Rotation</h1>
      </Header>
      <Main>
        <CaamDashboard />
      </Main>
    </>
  )
}
