---
category: boundaries
---

# Boundaries

> The named external dependencies that shape duraclaw's invariants. For each one: what duraclaw assumes about the dependency, and what would break if the assumption changed.

Duraclaw deliberately leans on external services for capabilities that are not core to its problem (durable storage, push delivery, authentication, code-mode crdt). Naming each of these dependencies and the assumption duraclaw is making is what lets boundary contract violations be detected as theory failures rather than mysterious bugs.

## `claude-agent-sdk`

The Claude Agent SDK is the library duraclaw wraps; every runner is essentially a thin process that runs one SDK query and pipes its events into the dial-back transport. **Assumption:** the SDK's on-disk session file is the resume contract — read-once-per-spawn, immutable per turn, located under the project directory by SDK convention. **Break:** if the file format or location changed (or if the SDK switched to a non-file resume model), every cross-spawn resume would fail and duraclaw would need a parallel transcript-replay mechanism to substitute. The session-store interface duraclaw uses to mirror the transcript bytes into Durable Object SQLite is the SDK's official extensibility seam for this; if that interface were removed, the lossless-failover invariant would be at risk.

## Cloudflare Workers + Durable Objects

The orchestrator runs on Cloudflare Workers, with per-session state living in Durable Objects. **Assumption:** Workers' execution model — single-request-scoped compute with a 30-second wall-clock and 128 MB memory cap, no Node APIs by default (Node compatibility is opt-in via a flag), bindings as the way services compose — and the Durable Object persistence model: SQLite-backed storage that survives redeploys, single-active-instance per id with the platform serializing concurrent requests. **Break:** a unit of work that needed sustained computation longer than the 30-second window would force a non-Worker host (a queue worker, a long-running container) into the architecture. A Durable Object pricing or behavior change that broke the per-id single-active guarantee would invalidate the assumption that the per-session Durable Object is the single source of truth for its session.

## Cloudflare D1

D1 is the orchestrator-wide registry: SQLite-compatible database for catalog-shape data. **Assumption:** D1 is SQLite-compatible (same SQL surface, same type system), eventually consistent across edge regions, and sufficient for catalog operations — sessions index, identity catalog, projects, user preferences, audit log. Read latency is acceptable for cold-start fallback paths but not for hot per-request paths. **Break:** D1 going read-only would freeze new session creation (no row to insert) but live sessions would continue (the Durable Object is the truth for their state). D1 dropping SQLite compatibility would break Drizzle, the auth integration, and a lot of catalog code paths.

## Cloudflare R2

R2 is duraclaw's object store: media offload (oversized image bytes that don't belong in SQLite) and the mobile OTA bundle distribution channel. **Assumption:** standard object-store semantics (write-once, read-many, atomic put), and that the Worker can stream objects through itself as a same-origin proxy without exposing public R2 URLs. **Break:** an R2 outage would degrade media display (existing references to media keys would 404) but would not break the core conversation flow. An OTA outage would freeze the mobile shell on its currently-installed bundle until R2 recovered.

## GitHub

GitHub is named because the spec / issue / PR conventions in duraclaw's workflow are written against it — issue numbers (`GH#nnn`) appear in spec filenames, in commit messages, and in cross-referencing prose. **Assumption:** a constant repo identifier (organization, repo name) is the link target for issues and PRs; no GitHub OAuth dependency exists. **Break:** changing the repo's organization or name would invalidate the literal cross-references but no auth or runtime path depends on GitHub being reachable. Adding a GitHub-OAuth login path would introduce a new authentication boundary and need a new entry in `trust.md`.

## Better Auth

Better Auth is the authentication library, integrated with the orchestrator-wide registry through a Drizzle adapter. **Assumption:** D1 is the adapter target, and email-and-password is the only enabled provider — third-party providers (Google, GitHub, etc.) are intentionally disabled. **Break:** enabling third-party providers would expand the trust model — new origins would need trusting, new credential sources would need handling on logout / rotation, and the cross-device session model would need re-examination. It would require a corresponding revision of `trust.md`.

## Capacitor + Firebase

Capacitor 8 wraps the orchestrator's SPA into an Android shell; Firebase is integrated for push notifications. **Assumption:** the Capacitor shell is a thin client over the Worker — same SPA, no bypass paths, talks to the Worker over the same routes as the desktop browser. Firebase is push-only; it does not host application data. **Break:** an iOS shell (currently absent) would require a parallel push integration (APNs, possibly with its own server-side credentials), so the Firebase assumption becomes Android-only and a new boundary entry would be needed.

## `yjs` + OPFS

`yjs` is the conflict-free replicated data type library used for collaborative document state in the docs subsystem; the Origin Private File System is the browser-native persistence layer for client-side reactive collections. **Assumption:** `yjs` semantics are stable across the version pinned in duraclaw, with crdt-merge correctness preserved across all clients on the same document version; OPFS is available in modern browsers as a per-origin persistent store with sufficient quota for cached collection state. **Break:** a `yjs` major-version skew across clients would risk a merge that produces inconsistent document state. An OPFS unavailability (private-browsing modes, restrictive embeddings) falls back to memory-only collections — caches are gone on tab close but the system remains correct because the orchestrator-wide registry is the synced layer's authority anyway.
