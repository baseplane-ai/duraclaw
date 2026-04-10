import { createFileRoute } from '@tanstack/react-router'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { signOut } from '~/lib/auth-client'

export const Route = createFileRoute('/_authenticated/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  return (
    <>
      <Header>
        <h1 className="text-lg font-semibold">Settings</h1>
      </Header>
      <Main>
        <div className="mx-auto max-w-3xl space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Account</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Sign out to verify the shell-wide auth flow.
              </p>
              <Button
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
      </Main>
    </>
  )
}
