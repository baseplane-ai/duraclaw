# GitHub

Source package / configuration: `apps/orchestrator/src/components/chain-status-item.tsx` (the `GH_REPO` constant, line 58) and `apps/orchestrator/src/lib/types.ts` (around line 83, the per-project `githubRepo` field comment cites the same `baseplane-ai/duraclaw` shape). The kata workflow's `GH#<n>` issue/PR linking lives in `packages/kata/`.

## Version

N/A — duraclaw uses **GitHub's public URL conventions**, not a pinned SDK. There is no `@octokit/rest` or `gh-api` dependency in any package.json. PR creation that does happen is shelled to the `gh` CLI in developer-local context (kata sessions), not from the Worker.

## Footprint

GitHub plays exactly two roles:

1. **Issue + PR linking via a hardcoded repo identifier** — chain-status badges and kata workflow IDs (`GH#<n>`) render as links to `https://github.com/baseplane-ai/duraclaw/issues/<n>` / `.../pull/<n>`. The `GH_REPO` constant in `chain-status-item.tsx` (`'baseplane-ai/duraclaw'`) is the literal value substituted into every such URL.
2. **PR creation in kata sessions** — the kata methodology shells to the `gh` CLI (e.g. `gh pr create`) inside session worktrees. This runs in the developer's local shell, with the developer's local `gh auth` credentials, not from the Worker. The orchestrator never calls the GitHub API.

Notably absent:

- **No GitHub OAuth.** Better Auth is configured for email + password only; there is no GitHub identity provider, no GitHub access token stored anywhere in D1.
- **No GitHub API client.** No package depends on `@octokit/rest`, `octokit`, or `gh-api`.
- **No webhook ingest.** Nothing in the Worker listens for GitHub webhooks.

## Repo identifier

`baseplane-ai/duraclaw` (the canonical `GH_REPO` constant). Spec filenames (`planning/specs/<n>-...md`), commit messages, and cross-referencing prose all assume issue numbers refer to issues / PRs in this repo.

## Assumptions

- Issues and PRs are identified by **integer numbers** that are unique within the repo and stable forever (GitHub never reuses them).
- Issues are linkable via `https://github.com/<repo>/issues/<n>` and PRs via `https://github.com/<repo>/pull/<n>` in **standard URL form** — those URL paths are part of GitHub's public web surface and not expected to change.
- **No auth is required** for the read paths the SPA links to (public-repo issue / PR pages); the user's browser handles whatever GitHub login state is needed when they click through.
- **PR creation goes through `gh` CLI** in the developer's local shell context, not via the Worker — the orchestrator has no GitHub credentials of its own.
- The `GH_REPO` constant is the **single source of truth** for the repo identifier inside the SPA; per-project overrides go through the per-project `githubRepo` field on `ChainSummary` (`apps/orchestrator/src/lib/types.ts`).

## What would break if

- **Repo rename or fork** (e.g. moving `baseplane-ai/duraclaw` to a new org) — every chain-status badge link, every `GH#<n>` reference in spec filenames, and every commit-message issue reference would point at dead URLs (404). Fix would be a one-line `GH_REPO` change plus a redirect-aware sweep of historical references; GitHub does redirect old repo URLs for some time but not indefinitely.
- **GitHub making issue / PR URLs non-standard** (e.g. introducing slugs in the path) would break the chain-status badge linking and force a templated URL builder instead of string concatenation.
- **GitHub API rate-limiting or pricing changes** would have **no effect** on duraclaw's runtime — the orchestrator doesn't call the API. Only developer-side `gh pr create` would be affected, and only at the per-developer rate limit.
- **GitHub going down** — the SPA still renders chain-status badges (the link targets just 404 when clicked); kata `gh pr create` calls fail in developer shells. The orchestrator runtime is unaffected.
- **Adding GitHub OAuth login** would be a **NEW integration**, not a change to this one — it would need a new boundary entry in `docs/theory/trust.md` (new credential source, new origin to trust, new logout / rotation flow), and would touch `apps/orchestrator/src/lib/auth.ts` rather than the `GH_REPO` constant.

## See also

- [`docs/theory/boundaries.md`](../theory/boundaries.md) — GitHub boundary entry.
- [`docs/theory/trust.md`](../theory/trust.md) — trust boundaries that auth providers participate in (where a GitHub OAuth integration would land if added).
- `apps/orchestrator/src/components/chain-status-item.tsx` — `GH_REPO` constant + chain-status badge link rendering.
- `apps/orchestrator/src/lib/types.ts` — per-project `githubRepo` field.
- `packages/kata/` — kata workflow methodology (`GH#<n>` IDs, `gh pr create` call sites).
