import { createFileRoute } from '@tanstack/react-router'
import { signOut } from '~/lib/auth-client'
import { Button, Card, CardContent, CardHeader, CardTitle } from '~/lib/components/ui'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  return (
    <main className="min-h-dvh px-4 pb-24 pt-20 sm:px-6 sm:pb-8 lg:px-10 lg:pt-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            Shell
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Phase 6 will expand this into the full settings surface. P0 ships the route and mobile
            shell entry point so the app layout already matches the planned navigation model.
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Better Auth is active. Sign out here to verify the shell-wide auth flow without
              returning to the sidebar.
            </p>
            <Button
              className="min-h-11"
              variant="outline"
              onClick={() => {
                signOut().finally(() => {
                  window.location.href = '/login'
                })
              }}
            >
              Sign Out
            </Button>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
