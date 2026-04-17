import { createFileRoute } from '@tanstack/react-router'
import { AgentOrchPage } from '~/features/agent-orch/AgentOrchPage'

export const Route = createFileRoute('/_authenticated/')({
  component: AgentOrchPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { session?: string; newSessionProject?: string; newTab?: boolean } => ({
    session: typeof search.session === 'string' ? search.session : undefined,
    newSessionProject:
      typeof search.newSessionProject === 'string' ? search.newSessionProject : undefined,
    newTab: typeof search.newTab === 'boolean' ? search.newTab : undefined,
  }),
})
