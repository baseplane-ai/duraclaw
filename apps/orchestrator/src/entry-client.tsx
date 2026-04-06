import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
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
