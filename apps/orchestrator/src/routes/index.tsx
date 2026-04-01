import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: WelcomePage,
})

function WelcomePage() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <h1 className="mb-2 text-lg font-semibold">Duraclaw</h1>
        <p className="text-sm text-muted-foreground">
          Select a session from the sidebar or create a new one.
        </p>
      </div>
    </div>
  )
}
