/**
 * /inbox — Global @-mention inbox (GH#152 P1.5 WU-D B15).
 *
 * Renders the user's mention feed across all arcs, sorted by
 * `mentionTs DESC`. Backed by `arcMentionsCollection` (synced
 * collection driven by `arcMentions` deltas on the user-stream WS).
 */

import { createFileRoute } from '@tanstack/react-router'
import { Header } from '~/components/layout/header'
import { Main } from '~/components/layout/main'
import { MentionsList } from '~/features/inbox/MentionsList'

export const Route = createFileRoute('/_authenticated/inbox')({
  component: InboxPage,
})

function InboxPage() {
  return (
    <>
      <Header fixed>
        <h1 className="text-lg font-semibold">Inbox</h1>
      </Header>
      <Main>
        <MentionsList />
      </Main>
    </>
  )
}
