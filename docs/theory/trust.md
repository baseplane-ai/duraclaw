---
category: trust
---

# Trust

> Every authentication and authorisation surface in duraclaw, what it gates, and what an attacker who compromises any one host can and cannot do.

Duraclaw runs across five hosts; the trust model is the set of credentials each host presents to the next one along the call chain, and the discipline about which credentials are allowed to be unset.

## The five boundaries

**1. Better Auth session cookie — Browser ↔ Worker.** The browser authenticates to the Worker tier with an email-and-password Better Auth session. Better Auth is configured for email/password only; third-party (OAuth) providers are intentionally not enabled. The session cookie (or its bearer-token equivalent for Capacitor clients, which lack a cookie jar across WebView restarts) is the gating credential for every API route. Cross-origin requests from the desktop SPA come from a static set of trusted origins; the Capacitor mobile shell uses a fixed `https://localhost`-style origin baked into the trustedOrigins list.

**2. Gateway bearer token — Worker ↔ gateway.** Every HTTPS call from the Durable Object tier to the gateway carries a bearer token (`CC_GATEWAY_API_TOKEN` in deploy configuration). The gateway compares the token against its configured value with a timing-safe comparison. **Open-if-unset** for local development convenience: if the gateway has no token configured, it accepts unauthenticated calls. This is a development-only seam and must never be relied on in production.

**3. Active callback token — Durable Object ↔ runner.** When the Durable Object decides a runner should exist, it mints an active callback token and includes it in the spawn payload sent to the gateway. The runner presents the token as a query parameter on the dial-back WebSocket. The Durable Object compares the presented token with the minted one via timing-safe comparison and accepts the connection only on match. Each token is **single-shot per spawn** — once a runner has dialed back, the token is rotated, and any subsequent dial bearing the old token is closed with an authorization-class code. This is the mechanism that turns the orphan case into a self-healing one.

**4. Docs-runner bearer token — Worker ↔ docs-runner.** A parallel bearer (`DOCS_RUNNER_SECRET`) gates the docs-runner role on the collaborative-document WebSocket. Same shape as the gateway bearer: timing-safe compare, **open-if-unset** for development convenience, must be set in production.

**5. Identity HOMEs — runner ↔ credentials.** Each runner is spawned with its `HOME` environment variable set to the directory associated with its session's currently-bound identity. The credentials file (`~/.claude/.credentials.json` under that HOME) is read by the SDK at startup. Because each runner is its own process and inherits no environment from any sibling runner, cross-identity credential bleed is impossible by construction — there is no shared filesystem path, no shared process state, no shared in-memory store that two identities could leak across.

## Open-if-unset discipline

Two of the bearer tokens — gateway and docs-runner — are open-if-unset, deliberately, to keep local development friction low. The discipline is that production sets them and staging sets them. There is no automated check that prevents a misconfigured production deploy from running with an unset bearer; the discipline is operational, and verification belongs in deployment process, not in code.

The Better Auth session cookie, the active callback token, and the identity HOMEs are not open-if-unset and have no such carve-out.

## Attacker model

Reasoning about the blast radius of a compromise at each host:

- **Worker compromise.** Full session control. The Worker holds bindings to every Durable Object class, holds the gateway bearer, and can mint active callback tokens through the Durable Object tier. A compromised Worker can spawn runners, inject user turns, read message history, and impersonate any user. This is the largest blast radius; defenses are platform-level (Cloudflare's tenant isolation) and operational (deploy hygiene, secret rotation).
- **Gateway compromise.** Ability to spawn and kill runners — but no SDK message access. The gateway never holds the active callback token after it forwards it to the runner; it never sees user turns, assistant responses, or tool results. A compromised gateway could spawn rogue runners, but those runners have no valid token to present at dial-back and would be rejected. It could also kill legitimate runners, which would be a denial-of-service but not a confidentiality breach.
- **Runner compromise.** A single session's SDK state, and only that session's. Each runner runs as its own process under its own HOME with its own credentials. There is no cross-session bleed because there is no shared state between runners — different process, different memory, different filesystem root for credentials. A compromised runner could exfiltrate the credentials of its own identity; the failover model means that identity gets cooled-down on rate-limit anyway, but a compromise still warrants identity rotation as a remediation.

The browser is treated as fully untrusted; everything traveling through the Worker is validated server-side. The user is also treated as the trust boundary against themselves — duraclaw does not implement multi-user-per-session authorization; a session is owned by exactly one user, and that user has the credentials to act on it.
