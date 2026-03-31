import { createFileRoute } from '@tanstack/react-router'
import { authClient } from '~/lib/auth-client'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const { data: session } = authClient.useSession()

  const handleSignOut = async () => {
    await authClient.signOut()
    window.location.href = '/login'
  }

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Duraclaw Orchestrator</h1>
        <div>
          {session?.user?.email && <span style={{ marginRight: 12 }}>{session.user.email}</span>}
          <button type="button" onClick={handleSignOut}>
            Sign Out
          </button>
        </div>
      </div>
      <p>Session management dashboard</p>
    </div>
  )
}
