import { createFileRoute } from '@tanstack/react-router'
import { AgentOrchPage } from '~/features/agent-orch/AgentOrchPage'

export const Route = createFileRoute('/_authenticated/')({
  component: AgentOrchPage,
  validateSearch: (search: Record<string, unknown>): { session?: string } => ({
    session: typeof search.session === 'string' ? search.session : undefined,
  }),
})
