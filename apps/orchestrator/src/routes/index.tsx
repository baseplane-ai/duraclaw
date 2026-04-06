import { createFileRoute } from '@tanstack/react-router'
import { Dashboard } from '~/lib/components/dashboard'

export const Route = createFileRoute('/')({
  component: Dashboard,
})
