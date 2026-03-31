---
date: 2026-03-31
topic: TanStack Start + Cloudflare Workers Vite Plugin Configuration
status: complete
github_issue: null
---

# Research: TanStack Start + Cloudflare Workers Vite Plugin Setup

## Context

The orchestrator app uses TanStack Start on Cloudflare Workers with Durable Objects. The Vite config needed verification against the official/canonical setup to ensure correctness.

## Questions Explored

1. What is the canonical `vite.config.ts` for TanStack Start on CF Workers?
2. Is `app.config.ts` needed?
3. What should `main` be in `wrangler.toml`?
4. How should the server entry work with Durable Object exports?
5. Should `@vitejs/plugin-react` be included?

## Findings

### Canonical vite.config.ts

Per both [Cloudflare docs](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/) and [TanStack hosting guide](https://tanstack.com/start/latest/docs/framework/react/guide/hosting):

```ts
import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tanstackStart(),
    react(),
  ],
})
```

**Key points:**
- Plugin order matters: `cloudflare` MUST come before `tanstackStart`
- `@vitejs/plugin-react` IS required and comes after `tanstackStart`
- `viteEnvironment: { name: 'ssr' }` is the required cloudflare config
- No `app.config.ts` is used — everything is in `vite.config.ts`

### Canonical wrangler.jsonc

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "your-app",
  "compatibility_date": "2026-03-31",
  "compatibility_flags": ["nodejs_compat"],
  "main": "@tanstack/react-start/server-entry"
}
```

- Default `main` should be `@tanstack/react-start/server-entry`
- When using a custom server entry (for DO exports, queue handlers, etc.), set `main` to your custom file path (e.g. `src/server.ts`)

### Custom Server Entry (for Durable Objects)

When you need to export Durable Objects or add Workers handlers:

```ts
import handler from '@tanstack/react-start/server-entry'
export { MyDurableObject } from './my-durable-object'

export default {
  fetch: handler.fetch,
  // Optional: queue, scheduled, etc.
}
```

This is the pattern from the [Cloudflare TanStack Start docs](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/).

### CF Environment Access

For accessing Cloudflare bindings (D1, KV, DOs), the recommended pattern uses `import { env } from 'cloudflare:workers'` rather than manually threading env through a global setter. This works with the CF Vite plugin's environment support.

### History

- TanStack Start migrated from **vinxi to native Vite** — this broke the old CF integration ([workers-sdk#9622](https://github.com/cloudflare/workers-sdk/issues/9622))
- Full `@cloudflare/vite-plugin` support was completed Sept 2025 ([TanStack/router#4473](https://github.com/TanStack/router/issues/4473))
- The integration is now stable and production-ready

## Current State vs Canonical

| Aspect | Our Config | Canonical | Status |
|--------|-----------|-----------|--------|
| Plugin order | `cloudflare, tanstackStart, react, tailwindcss` | `cloudflare, tanstackStart, react` | OK (tailwindcss extra is fine) |
| cloudflare config | `{ viteEnvironment: { name: 'ssr' } }` | Same | OK |
| `@vitejs/plugin-react` | Included | Required | OK |
| `main` in wrangler | `src/server.ts` | Custom entry for DO exports | OK |
| Server entry | Wraps handler with `setCloudflareEnv()` | Direct `handler.fetch` or wrap | OK, but see recommendation |
| `app.config.ts` | Not present | Not needed | OK |

### Issue: `setCloudflareEnv` pattern

Our server entry wraps `handler.fetch` to call `setCloudflareEnv(env)` — a manual global env setter. The modern canonical approach is to use `import { env } from 'cloudflare:workers'` which gives access to bindings anywhere without manual threading. This would eliminate the `cf-env.ts` module entirely.

## Recommendations

1. **Config is largely correct** — plugin order, cloudflare config, and server entry pattern all match the canonical setup
2. **Consider migrating to `cloudflare:workers` env import** — replaces `setCloudflareEnv()` global with the native `import { env } from 'cloudflare:workers'` pattern
3. **No `app.config.ts` needed** — confirmed not part of the CF Workers setup
4. **Tailwind CSS vite plugin placement is fine** — it's an additive plugin that doesn't conflict

## Sources

- [Cloudflare Workers: TanStack Start Guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/)
- [TanStack Start: Hosting Guide (Cloudflare)](https://tanstack.com/start/latest/docs/framework/react/guide/hosting)
- [TanStack Start: Basic Cloudflare Example](https://tanstack.com/start/latest/docs/framework/react/examples/start-basic-cloudflare)
- [TanStack/router#4473 — Full CF Vite plugin support](https://github.com/TanStack/router/issues/4473)
- [cloudflare/workers-sdk#9622 — vinxi migration breakage](https://github.com/cloudflare/workers-sdk/issues/9622)
- [tanstack-drizzle-d1-durable-object-starter](https://github.com/jillesme/tanstack-drizzle-d1-durable-object-starter)
