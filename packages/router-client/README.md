# @duraclaw/router-client

Zero-dependency TypeScript client for [UncommonRoute](https://github.com/anjieyang/IYKYK) — a local LLM router that sits between an Anthropic/OpenAI/Claude-Agent SDK caller and the upstream API, routing prompts by difficulty to cut premium-model spend without sacrificing quality.

Designed to be a drop-in config layer for anything in the Duraclaw monorepo that calls an LLM:

- `@duraclaw/session-runner` (Claude Agent SDK `query()`)
- anything using `@anthropic-ai/sdk` or `openai` directly
- raw `fetch` / the Vercel AI SDK / custom clients

## Why a package instead of a baseURL env var

UncommonRoute accepts `x-session-id` (and `x-openclaw-session-key`) to correlate per-session cache keys and — once session-aware routing lands — per-session policies. The proxy also stamps `x-uncommon-route-*` response headers carrying tier, model, cache mode, token counts, and more on every routed response. Wiring both sides by hand at every call site is error-prone; this package centralises it.

## Install

Workspace-linked, no external install needed:

```json
{
  "dependencies": {
    "@duraclaw/router-client": "workspace:*"
  }
}
```

## Usage

### Claude Agent SDK (session-runner)

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { routerConfig } from "@duraclaw/router-client";

const cfg = routerConfig({
  routerUrl: process.env.UNCOMMON_ROUTE_URL ?? "http://127.0.0.1:8403",
  sessionId: sessionId, // the Duraclaw SessionDO id
});

for await (const ev of query({
  prompt,
  options: { fetch: cfg.fetch, baseURL: cfg.baseURL },
})) {
  // ...
}
```

### Anthropic SDK

```ts
import Anthropic from "@anthropic-ai/sdk";
import { routerConfig } from "@duraclaw/router-client";

const client = new Anthropic({
  ...routerConfig({ routerUrl, sessionId }),
});
```

### OpenAI SDK

```ts
import OpenAI from "openai";
import { routerConfig } from "@duraclaw/router-client";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  ...routerConfig({ routerUrl, sessionId }),
});
```

### Raw fetch / other clients

```ts
import { wrapFetch } from "@duraclaw/router-client";

const fetch = wrapFetch({ routerUrl, sessionId });
const res = await fetch(`${routerUrl}/v1/messages`, { method: "POST", body: ... });
```

### Reading routing metadata off a response

Every routed response carries `x-uncommon-route-*` headers — tier, model,
token counts, cache mode, and more. Parse them into a typed record:

```ts
import { parseRouteHeaders } from "@duraclaw/router-client";

const res = await client.messages.create({ ... });
const meta = parseRouteHeaders(res.headers);
//   meta.tier          → "MEDIUM"
//   meta.decisionTier  → "HARD"
//   meta.model         → "claude-sonnet-4-6"
//   meta.cacheMode     → "prompt_cache_key"
//   meta.inputTokensBefore / .inputTokensAfter
//   … and more, all typed.
```

This surface is the autoresearch-loop input — every decision the router
made is legible without polling stats storage.

## API

| Export                | Purpose                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `routerConfig(opts)`  | `{ baseURL, defaultHeaders, fetch }` ready to spread into any SDK  |
| `wrapFetch(opts)`     | Header-injecting `fetch` for SDK-agnostic use                      |
| `parseRouteHeaders()` | Parse `x-uncommon-route-*` response headers → `RouteMetadata`      |
| `hasRouteMetadata()`  | Cheap check for whether a response came from UncommonRoute         |
| `SESSION_HEADER`      | `"x-session-id"` — the default session header                      |
| `OPENCLAW_SESSION_HEADER` | `"x-openclaw-session-key"` — OpenClaw-compatible alternative    |

## Design notes

- **Zero runtime dependencies.** Only uses WHATWG `fetch`, `URL`, `Headers`.
- **SDK-version-independent.** Never imports `@anthropic-ai/sdk` or `openai` — they're consumers, not deps.
- **User headers win.** Per-call `init.headers` override `routerConfig` defaults; `routerConfig.headers` override `sessionId`.
- **Fails loudly on misconfig.** Empty or malformed `routerUrl` throws at config time, not on the first request.
