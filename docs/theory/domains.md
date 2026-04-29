---
category: domains
---

# Domains

> The entity types duraclaw deals in, who owns each one, and the phases each entity moves through.

Duraclaw is a session orchestrator built around a small handful of long-lived entity types. Every operational behavior — spawn, resume, failover, reap, fork — can be read off as a transition over one of these entities. Naming and bounding the entities up front is what lets the rest of the theory stay sharp.

## Session

A Session is a single Claude Code conversation: one logical thread of user turns and assistant turns, with its own message history, branch tree, and identity binding. Each session has a stable id that outlives the lifetime of any individual runner process.

**Owned by** the per-session Durable Object. The Durable Object is authoritative for session state — it holds the message history, the active callback token, the runner session id (when one has been minted), and the identity currently bound to the session. The orchestrator-wide registry stores a row per session as a cold-start fallback only.

**Phases**

- `idle` — no live runner; the session exists, history is durable, no work is in flight. Transition: enters this phase on first creation, after the reaper kills the runner, or after a clean `result` settles and the runner closes.
- `spawning` — a spawn intent has been issued and the dial-back has not yet completed. Transition: enters on user send / new-session intent; exits when the runner dials back and the WS is accepted.
- `running` — a runner is connected and actively processing a turn. Transition: enters on dial-back acceptance or stream-input injection; exits on `result`, gate, interrupt, or error.
- `awaiting-gate` — the runner is paused on a user-decision (ask_user or permission_request). Transition: enters when a gate event is received; exits when the user resolves or cancels.
- `cooled-down` — the active identity has hit a rate limit or auth error and the session is between identities. Transition: enters on a rate_limit event; exits when the next identity is selected and the resume dial completes.
- `interrupted` — the user has explicitly interrupted the in-flight turn. Transition: enters on user interrupt; exits when the runner acknowledges and re-enters `idle` or `running`.
- `errored` — a non-recoverable runtime fault. Transition: enters on terminal SDK error or transport failure that defeats reconnect; exits only by user action (retry, fork, archive).

## Identity

An Identity is a named authentication context for a Claude runner. Each identity owns an isolated HOME directory containing its own credentials file; runners spawned under an identity inherit only that identity's credentials, by construction. Identities exist to support failover when the active credential hits a rate limit or auth error.

**Owned by** the orchestrator-wide identity catalog. The catalog is admin-managed; sessions consult it through the Durable Object at spawn time. Each session records which identity owns the current run, so subsequent resumes know what they were running under.

**Phases**

- `available` — selectable by the LRU policy at spawn time.
- `cooldown` (until `<timestamp>`) — temporarily unselectable because of a recent rate limit or auth error. Lazy expiry: the identity becomes available again the first time the LRU sees its cooldown timestamp in the past. No cleanup job.
- `unconfigured` — the catalog is empty (no identities registered). The orchestrator falls back to a single-HOME mode and identity rows are not consulted. This is the zero-config default.

## Project

A Project is a registered code root — typically a worktree-like directory the user wants to run sessions against. It carries display-name, origin URL, and a docs-tree pointer used by the docs-collab subsystem.

**Owned by** the user (per-user collection in the orchestrator-wide registry). Projects are user-scoped; admin operations on the catalog are out of scope for this entity.

**Phases**

- `active` — visible in project pickers and selectable as a session target.
- `archived` — soft-deleted; hidden from default views but referencable from existing sessions. No data loss; restoration is a metadata flip.

## Worktree

A Worktree is a per-clone working tree on the VPS — a single checked-out copy of a repository at a given branch. Code-touching sessions reserve a worktree for the duration of their work; read-only sessions (research, planning, freeform) skip reservation entirely.

**Owned by** the worktrees registry, keyed on filesystem path. Reservations are recorded as a JSON tag carrying the reserving entity's kind and id; a worktree without a reservation is `free`.

**Phases**

- `present` — the directory exists on disk and is registered. Sub-states: `free`, `held` (reserved by a session or an arc), `released` (in the cleanup grace window).
- `pruned` — removed from disk and from the registry. Terminal.

## Runner

A Runner is the per-session Claude SDK process. It is spawned by the gateway at the Durable Object's request, runs exactly one SDK query for one session, and dials the Durable Object directly over a WebSocket. Each runner is single-tenant, single-identity, single-session.

**Owned by** the per-session Durable Object logically — the Durable Object decides when a runner should exist and when one is unwelcome. The gateway is the spawn mechanism, not the owner: it spawns and reaps but it does not author intent. Runners that are alive on the VPS but not endorsed by their session's Durable Object are by definition orphans.

**Phases**

- `spawning` — process started, dial-back not yet established.
- `running` — connected to its Durable Object, actively serving turns.
- `dialed-back` — a stable steady state of `running`; named explicitly because gateway restart and Worker redeploy are non-events for a runner already in this state.
- `closed (4xx code)` — the Durable Object closed the dial-back with an authorization-class code (e.g. invalid token, rotated token). The runner aborts and exits cleanly rather than retrying.
- `orphaned` — alive on the VPS, unreachable from its Durable Object. Self-heals on the next 4xx close from the Durable Object; recovered from the Durable Object side via fork-with-history.
- `reaped (>30min idle)` — killed by the gateway's idle reaper. The Durable Object is informed via an RPC and updates session state to `idle`.

## Gate

A Gate is a paused conversation awaiting a user decision. Two kinds: `ask_user` (a free-form question from the assistant) and `permission_request` (a tool wants to run, the user must approve or deny). While a gate is open the runner's command queue is parked.

**Owned by** the per-session Durable Object. The Durable Object holds the gate state, broadcasts gate events to clients, and routes resolution back to the runner.

**Phases**

- `open` — awaiting user input. The runner is parked.
- `resolved (with payload)` — user supplied a response; the resolution is delivered to the runner via a resolve-gate command and the queue resumes.
- `cancelled` — user dismissed the gate without supplying a response. The runner is informed and either re-prompts or exits the turn.

## Ownership table

| Entity | Owned by | Phase set |
|--------|----------|-----------|
| Session | Per-session Durable Object | idle / spawning / running / awaiting-gate / cooled-down / interrupted / errored |
| Identity | Orchestrator identity catalog | available / cooldown / unconfigured |
| Project | User (per-user collection) | active / archived |
| Worktree | Worktree registry | present (free/held/released) / pruned |
| Runner | Per-session Durable Object (logical); gateway (mechanism) | spawning / running / dialed-back / closed / orphaned / reaped |
| Gate | Per-session Durable Object | open / resolved / cancelled |
