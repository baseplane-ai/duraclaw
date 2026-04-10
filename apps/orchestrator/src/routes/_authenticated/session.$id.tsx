import { createFileRoute } from '@tanstack/react-router'
import { ChatView } from '~/lib/components/chat-view'

export const Route = createFileRoute('/_authenticated/session/$id')({
  component: SessionPage,
})

function SessionPage() {
  const { id } = Route.useParams()
  return <ChatView sessionId={id} />
}
