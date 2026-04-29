---
category: topology
---

# Topology

> Where each piece of duraclaw runs, what it owns, who it can talk to, and what survives whose restart.

Duraclaw spans five hosts. They are not interchangeable; each one is doing a specific, narrow job, and the boundaries between them are load-bearing.

## The five hosts

**Browser.** The user-facing client. A single-page app served from the orchestrator, with a small Capacitor wrapper for the Android shell. Holds reactive caches in the Origin Private File System, opens WebSockets to the orchestrator for live data, and never talks directly to the gateway or the runner. The mobile shell is the same SPA running inside Capacitor 8 with Firebase push integrated for notifications; it has no privileged paths the desktop browser doesn't have.

**Cloudflare Worker (orchestrator).** The frontend tier. Serves static SPA assets, runs the Hono-based API routes, hosts the Better Auth integration, and holds bindings to every Durable Object class. The Worker is the only host that talks to D1 (the orchestrator-wide registry) and R2 (media + OTA bundle distribution). It is also the only host that is allowed to issue HTTPS requests to the gateway.

**Per-session Durable Object.** One Durable Object per session, hosted on Cloudflare. Owns the session's SQLite database (message history, branch tree, identity binding, runner session id, active callback token, event log, typed metadata row) and is authoritative for session state and spawn intent. The Durable Object is the WebSocket peer the runner dials back to — once the WebSocket is up, all session-level traffic flows here, not through the Worker layer above it.

**VPS agent gateway.** A long-running Bun HTTP server on a VPS, supervised by systemd. Pure control plane: it spawns runners on request, lists running runners, reaps idle ones, and that is the entirety of its job. It does not embed the Claude SDK, it does not buffer messages, it does not proxy events. Its restart is a non-event for any runner that has already dialed back.

**VPS session runner.** A per-session process spawned by the gateway, also a Bun executable. Owns exactly one Claude SDK query for exactly one session, dials back to its session's Durable Object, and stays alive across turns until the SDK aborts, the runner receives SIGTERM, or the Durable Object closes the connection with an authorization-class code. Runners are single-tenant by construction: one process, one HOME, one identity, one session.

There is also a parallel docs-runner role for collaborative document state (driven by yjs); it follows the same shape — VPS-side, dialed-back, single-purpose — but is out of scope for the session lifecycle described elsewhere.

## Edge directionality

Every edge in duraclaw has a direction. Reading them out:

- **Browser → Worker.** HTTPS for static assets and API requests; WebSockets for live data. Once a WebSocket is upgraded, traffic is bidirectional over the same socket.
- **Worker → Durable Object.** A binding call, in-process to Cloudflare's runtime. There is no network hop here; the Worker dispatches to the Durable Object via the platform's RPC.
- **Durable Object → gateway.** HTTPS POST to the gateway's `/sessions/start` endpoint, authenticated by a bearer token. The Durable Object is the *only* thing that talks to the gateway; the Worker tier never reaches the gateway directly.
- **Gateway → runner.** A process spawn, detached. After the spawn, the gateway has no direct channel to the runner — it can list and kill (by PID), but it cannot inject messages.
- **Runner → Durable Object.** A WebSocket dial-back, the only edge from a runner to anywhere. Authenticated by the active callback token. Once accepted, all command and event traffic flows over this single socket.

There is no edge from Browser to gateway, none from Browser to runner, none from Worker to runner, none from runner to anywhere except its session's Durable Object. The graph is a tree rooted at the Durable Object plus a control-plane HTTPS link from the Durable Object down to the gateway.

## Restart non-events

Three classes of restart are explicitly designed to be invisible to in-flight work:

- **Gateway restart.** A runner already dialed back to its Durable Object is unaffected. The dial-back WebSocket does not traverse the gateway; the gateway is a control plane that has finished its job. The systemd unit uses a process-only kill mode so the gateway's own restart does not propagate to its detached runner children.
- **Worker / Durable Object redeploy.** The runner's outbound buffer holds events while the WebSocket is down; on reconnect (with backoff: 1s, 3s, 9s, 27s, 30s and held there) it replays the buffer in order. The Durable Object resumes from its SQLite state. A single gap sentinel is emitted only if the buffer overflows, and the client responds to it with a snapshot request.
- **Browser refresh.** Message history reloads from the Durable Object via a snapshot frame on WebSocket open; reactive caches are repopulated from the snapshot. The user sees the same conversation they left.

Restart-as-noop is what lets duraclaw deploy continuously without coordinating with active sessions. There is no maintenance window; there is no "drain before deploy."

## Durable Object observability

Each Durable Object maintains a structured event log inside its own SQLite database — durable, with roughly seven days of retention, garbage-collected when the Durable Object rehydrates. Logs carry level, tag, message, and an optional attribute bag, written via a single logging entry-point so the discipline is enforceable.

Tag prefixes are conventional and consistent: `gate` for gate lifecycle (ask_user, permission_request), `conn` for WebSocket connection events, `rpc` for callable entry and exit, `reap` for reaper kill / skip decisions reported back from the gateway. Querying the log is a per-session RPC that takes optional tag and time-since filters.

The persistent event log is the persistence path. Logs are also mirrored to standard output for live tailing during ops work, but the live tail is a convenience, not the source of truth. No external log infrastructure is required for per-session replay.

## What persists across each restart

| Restart kind | What survives |
|--------------|---------------|
| Browser refresh | Message history (Durable Object SQLite) |
| Worker redeploy | Durable Objects + D1 + R2 |
| Durable Object redeploy | D1 + R2; the Durable Object rehydrates from its own SQLite |
| Gateway restart | The runner stays alive (detached process) |
| Runner crash | Durable Object SQLite + on-disk SDK transcript file (resume on next spawn) |
