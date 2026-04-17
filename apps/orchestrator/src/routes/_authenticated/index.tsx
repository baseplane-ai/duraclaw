import { createFileRoute } from '@tanstack/react-router'
import { AgentOrchPage } from '~/features/agent-orch/AgentOrchPage'

export const Route = createFileRoute('/_authenticated/')({
  component: AgentOrchPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { session?: string; project?: string; newSessionProject?: string; newTab?: boolean } => ({
    session: typeof search.session === 'string' ? search.session : undefined,
    project: typeof search.project === 'string' ? search.project : undefined,
    newSessionProject:
      typeof search.newSessionProject === 'string' ? search.newSessionProject : undefined,
    newTab: typeof search.newTab === 'boolean' ? search.newTab : undefined,
  }),
})
