# Better Auth

Source package / configuration: `apps/orchestrator/src/lib/auth.ts` (the `createAuth()` factory — per-request because D1 bindings are only available in request context).

## Version

Pinned at `^1.5.6` in `apps/orchestrator/package.json` -> `dependencies."better-auth"`. Companion plugin `better-auth-capacitor` pinned at `^0.3.6` for the mobile shell's bearer-token replay.

## Footprint

Better Auth is the orchestrator's authentication library. The session cookie it issues is the gating credential for every `/api/*` route except a small allowlist of public routes (e.g. `POST /api/mobile/updates/manifest`). Construction lives in `createAuth()` (`apps/orchestrator/src/lib/auth.ts` lines 47-74) and uses the **Drizzle adapter for D1** with the SQLite provider:

```ts
betterAuth({
  database: drizzleAdapter(db, { provider: 'sqlite', schema: { user, session, account, verification } }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins,                       // dura subdomain + capacitor:// + https://localhost
  emailAndPassword: { enabled: true, disableSignUp: !opts?.allowSignUp },
  plugins: [admin(), bearer(), capacitor()],
})
```

Plugins:

- `admin()` — admin role + admin-only routes.
- `bearer()` — extracts session tokens from `Set-Cookie` into a `set-auth-token` response header (with `Access-Control-Expose-Headers`) so the Capacitor client can store the token; on inbound requests, converts `Authorization: Bearer <token>` back to a cookie for server-side session lookup.
- `capacitor()` — adds `capacitor://` to `trustedOrigins` and enables bearer-token replay for the mobile WebView (which has no cookie jar that survives WebView restarts).

The Drizzle schema in `apps/orchestrator/src/db/schema.ts` (`users`, `sessions`, `accounts`, `verifications`) is canonical for the auth tables. The login UI lives at `/login`; auth API at `/api/auth/*`.

## Configuration

- **Email + password ONLY.** No GitHub OAuth, no magic link, no Google / Apple / social providers. `emailAndPassword: { enabled: true }` is the sole credential source.
- **Sign-up is gated** — `disableSignUp: !opts?.allowSignUp` keeps public sign-up off; new accounts are created via the admin / bootstrap flow.
- **Cookie scope** — issued for the `dura.baseplane.ai` custom domain in production. `trustedOrigins` is a function in local dev (so wrangler's URL rewriting still passes CSRF) and a static list (`['https://localhost']`) in production for the Capacitor WebView's `androidScheme: 'https'`.

## Assumptions

- D1 (`AUTH_DB`) is the **single source of truth** for users + sessions + accounts + verifications.
- The Drizzle schema in `apps/orchestrator/src/db/schema.ts` matches what Better Auth expects from the SQLite provider — column names and types are part of the contract.
- Cookie scope is the **`dura.baseplane.ai`** subdomain; that domain shape is load-bearing for cross-origin behavior in the Capacitor shell.
- Email + password is the only credential source — no third-party identity provider has issued any token in this system.
- The bearer-token replay scheme is acceptable for the Capacitor shell (i.e., the bearer plugin's security model is equivalent to the cookie's, since both ride a TLS channel to the same origin).

## What would break if

- Enabling **third-party providers** (Google / GitHub / Apple) would expand the trust model: new origins to trust, new credential sources to handle on logout / rotation, new boundary entry needed in `docs/theory/trust.md`.
- Switching **adapters away from D1** (e.g., to a Postgres adapter) would require a data migration of users / sessions / accounts / verifications.
- Renaming the **`dura.baseplane.ai`** domain breaks the cookie scope — every browser logged out, every Capacitor WebView's bearer token rejected on next request.
- A Better Auth SemVer-major bump rewriting the `set-auth-token` response header convention or the cookie name -> the Capacitor shell's `better-auth-capacitor` plugin would need a coordinated upgrade.
- Re-enabling public **sign-up without admin gating** would invalidate the closed-account assumption that the rest of the orchestrator (project allowlists, identity catalog) implicitly relies on.

## See also

- [`docs/theory/boundaries.md`](../theory/boundaries.md) — Better Auth boundary entry.
- [`docs/theory/trust.md`](../theory/trust.md) — trust boundaries that Better Auth participates in.
- `apps/orchestrator/src/lib/auth.ts` — `createAuth()` factory (per-request).
- `apps/orchestrator/src/db/schema.ts` — canonical Drizzle schema for the auth tables.
