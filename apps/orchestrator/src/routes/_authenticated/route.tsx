import { createFileRoute } from '@tanstack/react-router'
import { AuthenticatedLayout } from '~/components/layout/authenticated-layout'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async () => {
    // Auth check happens in __root.tsx via useSession
    // This layout route just wraps with the shell
  },
  component: AuthenticatedLayout,
})
