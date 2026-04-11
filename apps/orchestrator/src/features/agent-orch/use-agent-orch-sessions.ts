/**
 * useAgentOrchSessions — Session management hook backed by ProjectRegistry DO.
 *
 * Replaces baseplane's DataForge-based hook with direct fetch calls
 * to duraclaw's ProjectRegistry Durable Object via API routes.
 */

import { useCallback, useEffect, useState } from 'react'
import type { SessionSummary } from '~/lib/types'

export interface SessionRecord extends SessionSummary {
  archived: boolean
}

export interface UseAgentOrchSessionsResult {
  sessions: SessionRecord[]
  isLoading: boolean
  createSession: (data: {
    id: string
    project: string
    model: string
    prompt: string
  }) => Promise<void>
  updateSession: (sessionId: string, patch: Record<string, unknown>) => Promise<void>
  archiveSession: (sessionId: string, archived: boolean) => Promise<void>
  refresh: () => Promise<void>
}

/**
 * Hook that provides session records from ProjectRegistry DO.
 * Sessions are sorted by updated_at desc.
 */
export function useAgentOrchSessions(): UseAgentOrchSessionsResult {
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchSessions = useCallback(async () => {
    try {
      const resp = await fetch('/api/sessions')
      if (resp.ok) {
        const json = (await resp.json()) as { sessions: SessionSummary[] }
        const data = json.sessions
        setSessions(
          data.map(
            (s): SessionRecord => ({
              ...s,
              archived: !!(s as SessionRecord).archived,
            }),
          ),
        )
      }
    } catch {
      // Ignore fetch errors — will retry on next poll
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSessions()
    // Poll every 5s for session list updates
    const interval = setInterval(fetchSessions, 5000)
    return () => clearInterval(interval)
  }, [fetchSessions])

  const createSession = useCallback(
    async (data: { id: string; project: string; model: string; prompt: string }) => {
      try {
        await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
        await fetchSessions()
      } catch (err) {
        console.error('[useAgentOrchSessions] Failed to create session:', err)
      }
    },
    [fetchSessions],
  )

  const updateSession = useCallback(async (sessionId: string, patch: Record<string, unknown>) => {
    try {
      await fetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      // Optimistic update
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, ...patch } : s)))
    } catch (err) {
      console.error('[useAgentOrchSessions] Failed to update session:', err)
    }
  }, [])

  const archiveSession = useCallback(async (sessionId: string, archived: boolean) => {
    try {
      await fetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: archived ? 1 : 0 }),
      })
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, archived } : s)))
    } catch (err) {
      console.error('[useAgentOrchSessions] Failed to archive session:', err)
    }
  }, [])

  return {
    sessions,
    isLoading,
    createSession,
    updateSession,
    archiveSession,
    refresh: fetchSessions,
  }
}
