# Dial-Back Runner

> A detached-spawn-with-dialback pattern. A spawner kicks off an ephemeral worker that immediately dials a long-lived authority; after the dial, the spawner is out of the message path.

## Layer test

This primitive survives a stack rewrite but NOT a UI redesign.

## Concept

A dial-back runner is the cross-cutting pattern that fuses three actors into one durable shape:

- **Spawner** — a small control-plane process that knows how to launch runners. Issues spawn intent; does not own work.
- **Runner** — the ephemeral worker that does the actual job. Owns one unit of work end-to-end.
- **Authority** — the long-lived coordinator the runner reports to. Persists state. Validates the runner's identity.

The flow:

1. Authority decides work needs to happen. Mints a single-shot token, persists it, asks the spawner (over an authenticated HTTP call) to launch a runner with `(callback_url, token, work_intent)`.
2. Spawner launches the runner **detached** (`setsid` or equivalent), passing the three arguments via env or argv. The spawner's child reference is dropped — the runner is no longer the spawner's process tree.
3. Runner immediately dials the authority at `callback_url?token=<bearer>` using the [dial-back-client](./dial-back-client.md) primitive.
4. Authority validates the token (timing-safe compare) and accepts the connection. The spawner is now **out of the message path** — every byte between runner and authority flows over the dial-back WebSocket.

After step 4, a spawner crash, restart, or upgrade does not interrupt the conversation. Runners are decoupled from the spawner's lifecycle.

## Why decoupling matters

The runner's correctness depends on its WebSocket to the authority, not on the spawner. Concretely:

- A spawner crash mid-conversation does not interrupt the conversation.
- A spawner upgrade does not require draining live runners.
- A `pnpm install` (or analogous dependency churn) on the spawner host can rewrite shared module trees without disturbing in-flight runners — see *Bundle vs source*, below.
- Failures partition cleanly: runner failures stay in the runner, spawner failures stay in the spawner, authority failures are absorbed by the dial-back-client's reconnect.

## The three-party trust model

| Pair | Trust direction |
|------|-----------------|
| **Spawner ↔ Authority** | Mutual, via a shared bearer secret. The authority calls the spawner to request a launch; the spawner trusts the authority's launch order; the authority trusts the spawner to pass through `(callback_url, token)` faithfully. |
| **Runner ↔ Authority** | One-way, via the single-shot token. The authority does not trust the runner until the token validates on dial. The runner trusts the authority by URL (the URL is published; the authority's TLS identity is the contract). |
| **Spawner ↔ Runner** | None. The spawner does not authenticate the runner and has no privileged channel to it. The spawner exists only to launch. |

This is what makes the spawner safely restartable: it holds no authoritative trust relationship with anything it spawned.

## Bundle vs source

Runners load as **self-contained bundles** — every workspace dependency, the SDK, and the dial-back transport are inlined into a single executable file at build time. The runner reads its bundle once at process start and never re-resolves modules from disk. As a result:

- A spawner-side `pnpm install` cannot disrupt an in-flight runner.
- A bundle-write-during-spawn race is solved with staging-dir + atomic `mv` at build time: a runner spawned mid-write reads either the old bundle or the new one, never a half-written one.
- Source-tree edits on the spawner host (`git pull`) are harmless because nothing in the running runner reads the source tree.

This is a precondition for the spawner-restart-is-a-non-event property; without it, "spawner restarts safely" decays into "spawner restarts as long as the dependency tree is stable", which is a much weaker contract.

## Reconnect & resume

If the authority is unreachable when the runner dials, the dial-back-client's backoff (`1/3/9/27/30 s`) handles the gap. If the runner is itself reaped (e.g. by an idle-timeout) and a follow-up arrives later, the authority spawns a fresh runner with a `resume` intent — the new runner reads its prior session context from durable storage owned by the authority, not from the previous runner's memory.

## Why this is a primitive, not a module

Any system where ephemeral workers must outlive their spawner faces the same questions: how does the worker authenticate to its real coordinator, how does the spawner stay safely restartable, how does dependency churn on the spawner host avoid wedging in-flight workers. The shape is portable across process supervisors — systemd, nomad, kubernetes sidecars, plain `setsid`. The trust triangle and the detach-then-dial sequence don't change.

## Where this lives in code

- `packages/agent-gateway/src/server.ts`, `packages/agent-gateway/src/handlers.ts` — spawner side; HTTP control plane.
- `packages/session-runner/src/main.ts` — runner side; one variant (Claude SDK session worker).
- `packages/docs-runner/src/main.ts` — runner side; second variant (yjs document worker).
- `packages/shared-transport/` — dial-back transport primitive used by both runner variants.
- `scripts/bundle-bin.sh` — build script that produces the self-contained runner bundles.
