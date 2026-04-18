// TODO(#7 p5): delete this file together with its single consumer
// (`features/agent-orch/AgentOrchPage.tsx` synchronous useState init).
//
// Background: p4 deleted the localStorage `duraclaw-sessions` cache (B-CLIENT-4).
// `lookupSessionInCache` was the synchronous bridge that AgentOrchPage used
// to seed selectedSessionId on first render — bypassing the TanStack DB
// collection layer entirely. With the OPFS race fixed (B-CLIENT-1) and the
// loading-gate skeleton in place, the synchronous lookup is no longer needed:
// the 1-frame delay before the collection hydrates is acceptable.
//
// This no-op shim keeps p4's typecheck green without forcing AgentOrchPage
// into p4's diff. P5 will rewrite that init logic to consume
// `agentSessionsCollection.get(sessionId)` (which is now reliably populated
// from OPFS on cold start) and delete this file.

export function lookupSessionInCache(_id: string): { project: string; title?: string } | null {
  return null
}
