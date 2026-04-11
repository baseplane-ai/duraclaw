import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_authenticated/session/$id')({
  beforeLoad: ({ params }) => {
    // Redirect /session/$id to /?session=$id for unified layout
    throw redirect({ to: '/', search: { session: params.id } })
  },
  component: () => null,
})
