import { useState } from 'react'
import { usePwaInstall } from '~/hooks/use-pwa-install'

export function PwaInstallBanner() {
  const { canInstall, install } = usePwaInstall()
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined') return true
    return localStorage.getItem('pwa-install-dismissed') === 'true'
  })

  if (!canInstall || dismissed) return null

  const handleInstall = async () => {
    await install()
  }

  const handleDismiss = () => {
    localStorage.setItem('pwa-install-dismissed', 'true')
    setDismissed(true)
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/50 p-4">
      <p className="text-sm text-muted-foreground">
        Install Duraclaw for quick access from your home screen.
      </p>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          onClick={handleDismiss}
          className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={handleInstall}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Install
        </button>
      </div>
    </div>
  )
}
