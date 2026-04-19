import { createFileRoute } from '@tanstack/react-router'
import { ChainPage } from '~/features/chain/ChainPage'

export const Route = createFileRoute('/_authenticated/chain/$issueNumber')({
  component: ChainRoute,
})

function ChainRoute() {
  const { issueNumber } = Route.useParams()
  const n = Number.parseInt(issueNumber, 10)
  return <ChainPage issueNumber={Number.isFinite(n) ? n : Number.NaN} />
}
