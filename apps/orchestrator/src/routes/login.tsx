import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { authClient } from '~/lib/auth-client'

export const Route = createFileRoute('/login')({
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    const { error: authError } = await authClient.signIn.email({
      email,
      password,
    })

    if (authError) {
      setError(authError.message ?? 'Authentication failed')
      return
    }

    navigate({ to: '/', search: {} })
  }

  return (
    <main className="relative min-h-dvh overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6 lg:px-8">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(250,250,250,0.12),_transparent_50%),linear-gradient(180deg,_rgba(39,39,42,0.65),_transparent)]" />
      <div className="relative mx-auto flex min-h-[calc(100dvh-5rem)] max-w-5xl items-center justify-center">
        <div className="grid w-full gap-8 lg:grid-cols-[1.15fr_0.85fr]">
          <section className="flex flex-col justify-center rounded-[30px] border border-border/70 bg-card/70 p-6 shadow-sm backdrop-blur sm:p-8">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              Duraclaw
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
              Session control for the Worker shell.
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
              Sign in to launch a session, monitor multi-project activity, and approve or answer
              interaction requests from the browser without losing the CLI workflow.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-border/70 bg-background/30 p-4">
                <p className="text-sm font-medium">SPA shell</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Worker API plus client-side routing.
                </p>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/30 p-4">
                <p className="text-sm font-medium">Mobile ready</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Bottom tabs, drawer navigation, safe-area padding.
                </p>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/30 p-4">
                <p className="text-sm font-medium">Auth enforced</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Session ownership is checked on API and WebSocket paths.
                </p>
              </div>
            </div>
          </section>

          <Card className="rounded-[28px] border-border/70 bg-card/85 shadow-lg backdrop-blur">
            <CardHeader className="space-y-2 pb-4">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                Access
              </p>
              <CardTitle className="text-2xl">Sign in</CardTitle>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={handleSubmit}>
                <div>
                  <label className="mb-1.5 block text-sm font-medium" htmlFor="login-email">
                    Email
                  </label>
                  <Input
                    className="min-h-11"
                    id="login-email"
                    onChange={(event) =>
                      setEmail((event.target as unknown as { value: string }).value)
                    }
                    placeholder="Email"
                    required
                    type="email"
                    value={email}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium" htmlFor="login-password">
                    Password
                  </label>
                  <Input
                    className="min-h-11"
                    id="login-password"
                    minLength={8}
                    onChange={(event) =>
                      setPassword((event.target as unknown as { value: string }).value)
                    }
                    placeholder="Password"
                    required
                    type="password"
                    value={password}
                  />
                </div>
                {error && (
                  <div className="rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {error}
                  </div>
                )}
                <Button className="min-h-11 w-full" type="submit">
                  Sign In
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  )
}
