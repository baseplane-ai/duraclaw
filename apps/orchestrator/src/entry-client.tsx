import { RouterProvider } from '@tanstack/react-router'
import { dbReady } from '~/db/db-instance'
import { evictOldMessages } from '~/db/messages-collection'

// Non-blocking eviction after DB is ready
dbReady.then(() => evictOldMessages()).catch(() => {})

import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { getRouter } from './router'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Missing #root mount point')
}

ReactDOM.createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={getRouter()} />
  </StrictMode>,
)
