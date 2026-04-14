/**
 * Hook for reading cached messages from the local messages collection.
 *
 * Returns messages filtered by sessionId, sorted by created_at.
 */

import { useLiveQuery } from '@tanstack/react-db'
import { useMemo } from 'react'
import { type CachedMessage, messagesCollection } from '~/db/messages-collection'

export function useMessagesCollection(sessionId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useLiveQuery((q) => q.from({ messages: messagesCollection as any }))

  const messages = useMemo(() => {
    if (!data) return []
    return (data as unknown as CachedMessage[])
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => {
        if (a.createdAt && b.createdAt) {
          const aTime =
            typeof a.createdAt === 'string'
              ? new Date(a.createdAt).getTime()
              : a.createdAt.getTime()
          const bTime =
            typeof b.createdAt === 'string'
              ? new Date(b.createdAt).getTime()
              : b.createdAt.getTime()
          return aTime - bTime
        }
        return 0
      })
  }, [data, sessionId])

  return { messages, isLoading }
}
