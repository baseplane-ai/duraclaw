import { createFileRoute, redirect } from '@tanstack/react-router'
import { GeminiModelsPanel } from '~/components/admin/gemini-models-panel'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { useSession as useAuthSession } from '~/lib/auth-client'

export const Route = createFileRoute('/_authenticated/admin/gemini-models')({
  component: AdminGeminiModelsPage,
})

function AdminGeminiModelsPage() {
  const { data: authSession } = useAuthSession()
  const role = (authSession as { user?: { role?: string } } | null)?.user?.role ?? 'user'

  if (role !== 'admin') {
    // Runtime gate — redirect non-admins to settings (Better Auth role lives
    // in the session payload, no admin-route loader infra exists yet).
    throw redirect({ to: '/settings' })
  }

  return (
    <>
      <Header fixed>
        <h1 className="text-lg font-semibold">Gemini Models</h1>
      </Header>
      <Main>
        <div className="mx-auto max-w-3xl flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Gemini Models</CardTitle>
            </CardHeader>
            <CardContent>
              <GeminiModelsPanel />
            </CardContent>
          </Card>
        </div>
      </Main>
    </>
  )
}
