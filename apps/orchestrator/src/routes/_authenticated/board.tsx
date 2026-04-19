import { createFileRoute } from '@tanstack/react-router'
import { KanbanBoard } from '~/features/kanban/KanbanBoard'

export const Route = createFileRoute('/_authenticated/board')({
  component: BoardRoute,
})

function BoardRoute() {
  return <KanbanBoard />
}
