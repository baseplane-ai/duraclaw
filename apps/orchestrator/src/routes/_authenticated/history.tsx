import { createFileRoute } from '@tanstack/react-router'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { SessionHistory } from '~/features/agent-orch/SessionHistory'

export const Route = createFileRoute('/_authenticated/history')({
  component: HistoryPage,
})

function HistoryPage() {
  return (
    <>
      <Header>
        <h1 className="text-lg font-semibold">Session History</h1>
      </Header>
      <Main>
        <SessionHistory />
      </Main>
    </>
  )
}
