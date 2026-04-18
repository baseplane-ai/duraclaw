// TODO(#7 p5): delete this file; consumers should import from
// `~/db/agent-sessions-collection` directly. Kept during p4 only to avoid
// breaking import sites that p5 will migrate.
export {
  agentSessionsCollection as sessionsCollection,
  type SessionRecord,
} from './agent-sessions-collection'
