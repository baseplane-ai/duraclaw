import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/maintenance')({
  component: MaintenancePage,
})

function MaintenancePage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="text-center space-y-4 max-w-md">
        <h1 className="text-2xl font-semibold">Migration in progress</h1>
        <p className="text-muted-foreground">
          We're upgrading our storage. Back in about 15 minutes.
        </p>
      </div>
    </div>
  )
}
