import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { dbReady } from '~/db/db-instance'
import { evictOldMessages } from '~/db/messages-collection'
import { installAriaHiddenPatch } from '~/lib/aria-hidden-patch'
import { getRouter } from './router'

installAriaHiddenPatch()

async function bootstrap() {
  // Block React mount until OPFS persistence has resolved.
  // Otherwise *-collection modules import a null persistence handle
  // and fall into the non-persisted branch (B-CLIENT-1).
  await dbReady
  try {
    evictOldMessages()
  } catch {
    // ignore — collection may be empty/uninitialised
  }

  const rootElement = document.getElementById('root')
  if (!rootElement) {
    throw new Error('Missing #root mount point')
  }

  ReactDOM.createRoot(rootElement).render(
    <StrictMode>
      <RouterProvider router={getRouter()} />
    </StrictMode>,
  )
}

void bootstrap()
