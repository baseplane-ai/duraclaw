---
date: 2026-04-29
topic: Constellation-Bench corpus audit — validate 6 candidate OSS repos
type: feasibility
status: complete
github_issue: null
items_researched: 6
---

# Research: Constellation-Bench corpus audit

## Context

Brainstorming a published benchmark — working name **Constellation-Bench** —
for AI coding capability across all layers of large established codebases.
Theme: self-hosted / federation OSS. Beyond a neutral leaderboard, the
benchmark doubles as a credibility receipt for Duraclaw's docs hierarchy +
kata workflow methodology via factorial ablations:

|              | No docs  | + Layered docs |
|--------------|----------|----------------|
| **No kata**  | Baseline | +Docs          |
| **+ Kata**   | +Kata    | +Both          |

**This research validates** that 6 candidate repos actually carry the layer
coverage claimed during brainstorm, before committing to corpus design.

## Scope

Items researched: 6 OSS repos.
Fields populated per repo: stats, liveness, layer hits L0–L7 with concrete
links, existing docs density (ablation headroom), benchmark contamination
check, KEEP/DROP/REPLACE verdict.
Sources: GitHub issues/PRs/files, official docs sites, ADRs, CVE feeds,
arXiv (for contamination), public benchmark leaderboards.
Method: 6 Explore agents in parallel, each with identical field template.

## Layer taxonomy (recap)

| L | Name | Tests |
|---|------|-------|
| L0 | Lexical / style | Match repo conventions |
| L1 | Type / API | Semantic correctness across modules |
| L2 | Behavior | Implement features against tests |
| L3 | Architecture | Boundaries, layering, extensibility |
| L4 | Data / schema | Migrations, backfills, compat windows |
| L5 | Concurrency / runtime | Races, ordering, idempotency |
| L6 | Build / deploy / infra | CI, packaging, multi-arch |
| L7 | Process / judgment | Review, escalation, "don't change this" |

## Findings

### Mastodon (github.com/mastodon/mastodon)

- **Stats**: ~350k LOC (Ruby 61%, TS 20%, JS 10%). 10 yrs old. ~21k commits.
  ~274 PRs/month merged. 4,200+ open issues. 49.8k stars.
- **Liveness**: Active; nonprofit governance since 2025; consistent merges.
- **Claimed strength (L2/L3/L4) — VERIFIED**:
  - L3: [FEDERATION.md](https://github.com/mastodon/mastodon/blob/main/FEDERATION.md)
    documents ActivityPub, WebFinger, HTTP Signatures, FEP compliance.
    Microservices (Puma/Sidekiq/Redis/Postgres/Node).
  - L4: 200+ migrations in [db/migrate/](https://github.com/mastodon/mastodon/tree/main/db/migrate).
    Pre/post-deployment migration pattern (`SKIP_POST_DEPLOYMENT_MIGRATIONS`)
    documented across major releases.
  - L2: RSpec + Vitest enforced via [CONTRIBUTING.md](https://github.com/mastodon/mastodon/blob/main/CONTRIBUTING.md).
- **Bonus layers**: L5 race PRs ([#17693](https://github.com/mastodon/mastodon/pull/17693),
  [#9272](https://github.com/mastodon/mastodon/pull/9272)). L7 strict scope
  policy ("PRs making large, unsolicited changes are unlikely to get a response").
- **Docs density**: Federation docs are dense; general architecture docs are
  moderate. Headroom for "+layered architecture docs" ablation.
- **Contamination**: Clean. Not in SWE-Bench (Python-only), not in
  BigCodeBench/Multi-SWE/Commit0.
- **Verdict**: **KEEP**. Primary Ruby/Rails + ActivityPub slot.

### Lemmy (github.com/LemmyNet/lemmy)

- **Stats**: Rust 78%, PLpgSQL 14%, TS 7%. 7 yrs old. 14k stars.
  129 open issues. ~80 PRs/month (June 2025 sample).
- **Liveness**: Active; refactor in progress
  ([#3670](https://github.com/LemmyNet/lemmy/issues/3670)).
- **Claimed strength (L1/L5) — VERIFIED**:
  - L1: 100+ typed request/response types in
    [lemmy_api_common](https://crates.io/crates/lemmy_api_common); Diesel
    type-safe queries; per-crate enum discipline in
    [db_schema](https://github.com/LemmyNet/lemmy/blob/main/crates/db_schema/src/lib.rs).
  - L5: Tokio async + federation queue. Real production scaling work
    documented at [lemmy.world post 818810](https://lemmy.world/post/818810)
    (workers scaled to 10k–360k). Concurrency-limiting issue
    [#4529](https://github.com/LemmyNet/lemmy/issues/4529).
- **Bonus layers**: L4 with 120+ migrations in
  [migrations/](https://github.com/LemmyNet/lemmy/tree/main/migrations).
  L3 hub-spoke topology discussion
  [#3245](https://github.com/LemmyNet/lemmy/issues/3245).
- **Docs density**: **Thin** — no in-repo architecture doc; CONTRIBUTING.md
  returned 404 during audit. **Best ablation headroom in the corpus.**
- **Contamination**: Clean.
- **Verdict**: **KEEP**. Primary Rust + federation slot.

### Matrix Synapse (github.com/element-hq/synapse)

- **Stats**: Python 89% + Rust 11% (PyO3 for event validation). ~344
  commits/month. 4.1k stars (post-fork numbers). 1,996 open issues
  (inherited from matrix-org archive).
- **Liveness**: **Active under Element ownership** post-2024 fork; AGPLv3
  + CLA model. Earlier "maintenance mode" reporting was outdated. Note: the
  Go fork **Dendrite** *is* in maintenance mode and is **not** a viable
  replacement.
- **Claimed strength (L3/L5) — VERIFIED**:
  - L3: Pluggable
    [module API](https://element-hq.github.io/synapse/latest/modules/) with
    callbacks + web resources; MSC (Matrix Spec Change) governance process.
  - L5: Real race
    [#19472](https://github.com/element-hq/synapse/issues/19472) (5×CPU
    spike from federation retry loop). Per-origin/per-room locking in
    [federation/](https://github.com/element-hq/synapse/tree/develop/synapse/federation).
- **Bonus layers**: L4 schema
  [migrations](https://github.com/element-hq/synapse/tree/develop/synapse/storage/schema).
  L7 — relicense + governance shift = real judgment material.
- **Docs density**: **Dense** ([element-hq.github.io/synapse](https://element-hq.github.io/synapse/latest/)).
  Less ablation headroom; useful as a contrast condition.
- **Contamination**: Clean.
- **Verdict**: **KEEP**. Primary Matrix protocol + worker concurrency slot.

### Home Assistant Core (github.com/home-assistant/core)

- **Stats**: Python primary. ~86k+ LOC. 13 yrs old. 21,000+ contributors
  (#1 by contributor count per Octoverse 2024). Monthly release cadence.
  3,713 open issues.
- **Liveness**: High-velocity; recently completed massive sync→async migration.
- **Claimed strength (L3) — VERIFIED + AMPLIFIED**:
  - L3: ~3,000 integrations under
    [components/](https://github.com/home-assistant/core/tree/dev/homeassistant/components).
    [Config Flow handler](https://developers.home-assistant.io/docs/config_entries_config_flow_handler/)
    pattern.
  - L7: **[ADR 0022 Integration Quality Scale](https://github.com/home-assistant/architecture/blob/master/adr/0022-integration-quality-scale.md)**
    (Bronze / Silver / Gold / Platinum tiers) is built-in judgment evaluation
    — rare in OSS.
- **Bonus layers**: L4 recorder schema migrations. L5 residual race issues
  ([#115193](https://github.com/home-assistant/core/issues/115193) and
  related), 2025.3 changelog fix for `async_get_integrations`.
- **Docs density**: **Dense** ([developers.home-assistant.io](https://developers.home-assistant.io/)).
- **Contamination — ⚠️ MODERATE-TO-HIGH**:
  - [LiveClawBench](https://arxiv.org/html/2604.13072v1) cites HA.
  - [home-assistant-datasets](https://github.com/allenporter/home-assistant-datasets)
    — public LLM eval datasets maintained by a core contributor.
  - 2025 papers on HA automation generation + on-device LLMs.
  - [SmartBench](https://arxiv.org/html/2603.06636) references HA.
- **Verdict**: **KEEP WITH SCOPE CONSTRAINTS**. Avoid automation /
  blueprint / assist tasks (already used in published evals). Restrict
  HA's slate to **integration architecture changes** (e.g., adding/refactoring
  a config flow, fixing a quality-scale gate violation, schema migration in
  recorder). Treat L3 + L7 as the primary targets; ignore L2 conversational
  AI tasks.

### Jellyfin (github.com/jellyfin/jellyfin)

- **Stats**: C# 99.7%. 7 yrs old (2018 GPL fork from Emby). 50.8k stars.
  857 open issues. ~22 commits/month on main repo (more activity in the
  jellyfin-packaging satellite).
- **Liveness**: Active; recent 10.11.x release cycle (Dec 2025 → Apr 2026);
  FFmpeg 7.1 integrated.
- **Claimed strength (L0/L6) — VERIFIED**:
  - L0: Enforced via
    [stylecop.json](https://github.com/jellyfin/jellyfin/blob/master/stylecop.json)
    + [.editorconfig](https://github.com/jellyfin/jellyfin/blob/master/.editorconfig).
    Dual-approval PR model.
  - L6: 7-component build system in
    [jellyfin-packaging](https://github.com/jellyfin/jellyfin-packaging) —
    Debian/Ubuntu, Docker multi-arch (amd64/arm64/arm32v7), portable .NET,
    Windows/macOS, NuGet, FFmpeg integration.
- **Bonus layers**: L5 — concurrent FFmpeg transcoding sessions w/ resource
  limits. L7 — 2018 GPL-violation fork is clean judgment story.
- **Docs density**: Dense ([jellyfin.org/docs](https://jellyfin.org/docs/)).
- **Contamination**: Clean. Not in SWE-Bench / LiveCodeBench / Aider Polyglot.
- **Verdict**: **KEEP**. Primary .NET / cross-platform build slot. The only
  C# repo in the corpus and pulls weight justifying inclusion.

### Vaultwarden (github.com/dani-garcia/vaultwarden)

- **Stats**: Rust 83%, Handlebars 10%, TS 4%. ~3,020 commits, 82 releases.
  17 open issues, 37 open PRs. **Smaller** than other corpus members
  (focused monolith).
- **Liveness**: Active but **single-maintainer dynamic** (BlackDex de
  facto lead). Bus factor risk noted.
- **Claimed strength (L7) — VERIFIED**:
  - 10+ recent CVE advisories (Feb–Apr 2026): broken access control
    ([CVE-2026-26012](https://nvd.nist.gov/vuln/detail/CVE-2026-26012)),
    2FA bypass ([CVE-2026-27801](https://cvefeed.io/vuln/detail/CVE-2026-27801)),
    privilege escalation ([CVE-2026-27802](https://www.sentinelone.com/vulnerability-database/cve-2026-27802/)).
  - **Wire-protocol entrapment**: must stay compatible with official
    Bitwarden clients. [#6729](https://github.com/dani-garcia/vaultwarden/issues/6729)
    is archetypal — adding a field breaks old clients; not adding it breaks
    new clients. Pure L7 negative-space material.
  - Trademark/branding navigation
    ([discussion #1635](https://github.com/dani-garcia/vaultwarden/discussions/1635)).
- **Other layers**: L1 (Diesel/Rust). L0/L2/L3/L4 weak — small codebase
  bounds the surface.
- **Docs density**: Moderate; wiki includes explicit "won't implement"
  scope disclaimers (rare and useful).
- **Contamination**: Clean.
- **Verdict**: **KEEP WITH RESERVATIONS**. Bus-factor risk is real but
  acceptable for a static corpus snapshot. The L7 archetypes Vaultwarden
  uniquely enables (security-judgment under wire-compat constraints) are
  unmatched elsewhere. **Fallback if maintainer freeze occurs**: Gitea
  security PRs (broader contributor base) or KeePassXC (different L1/L2
  profile).

## Layer coverage matrix (post-audit)

| Layer | Strong | Moderate | Weak |
|-------|--------|----------|------|
| L0 lexical | Jellyfin (StyleCop+EditorConfig), Mastodon (RuboCop+ESLint) | Lemmy, Synapse | Vaultwarden, HA |
| L1 type/API | Lemmy (Rust+Diesel) | Vaultwarden, Synapse | Mastodon |
| L2 behavior | Mastodon (RSpec+Vitest), HA (integration tests) | Synapse, Lemmy, Jellyfin | Vaultwarden |
| L3 architecture | HA (3k integrations + ADR), Synapse (modules+MSC) | Mastodon, Lemmy | Jellyfin, Vaultwarden |
| L4 data | Mastodon (200+), Lemmy (120+) | Synapse, HA recorder | Jellyfin, Vaultwarden |
| L5 concurrency | Synapse (#19472), Lemmy (queue) | HA (residual races), Jellyfin (transcode) | Mastodon, Vaultwarden |
| L6 build/deploy | Jellyfin (multi-arch + FFmpeg) | Mastodon, HA, Lemmy, Synapse | Vaultwarden |
| L7 judgment | Vaultwarden (CVE+compat), HA (Quality Scale) | Synapse (relicense), Jellyfin (fork), Mastodon (scope policy) | Lemmy |

**Result**: every layer has at least 2 "strong" or "moderate" coverage
sources. Defensible "all layers" claim.

## Comparison

| Repo | Lang | LOC | Stars | Open issues | Docs | Contamination | Slot |
|------|------|-----|-------|-------------|------|---------------|------|
| Mastodon | Ruby + TS | ~350k | 49.8k | 4,200 | Mod | Clean | ActivityPub / Rails |
| Lemmy | Rust | mid | 14k | 129 | Thin | Clean | Federation Rust |
| Synapse | Py + Rust | large | 4.1k | 1,996 | Dense | Clean | Matrix protocol |
| HA | Python | 86k+ | many | 3,713 | Dense | **Mod-High** | Plugin architecture |
| Jellyfin | C# | mid | 50.8k | 857 | Dense | Clean | .NET / build |
| Vaultwarden | Rust | small | many | 17 | Mod | Clean | Security judgment |

## Recommendations

1. **KEEP all 6** as the Constellation-Bench corpus. Layer matrix is
   defensible; polyglot coverage spans 6 languages, 3 federation
   protocols, .NET, plugin frameworks, and security-critical Rust.

2. **Scope HA tasks tightly** to integration architecture and recorder
   schema. Avoid automation / blueprint / assist conversational tasks —
   those have published-eval contamination via LiveClawBench,
   home-assistant-datasets, and 2025 papers. Document this in the
   benchmark methodology section.

3. **Treat docs density as ablation signal, not noise**. The "+layered
   docs" condition will show different effect sizes across repos because
   their existing docs vary from thin (Lemmy) to dense (Synapse, HA,
   Jellyfin). Per-repo Δ is publishable data, not a confound.

4. **Document Vaultwarden bus-factor caveat** in the spec. Acceptable for
   static snapshot benchmark; flag as risk if benchmark goes live with
   rolling task refresh.

5. **Synapse + Mastodon + Lemmy = 3 federation repos**. Not redundant: 3
   different protocols (Matrix vs ActivityPub-microblog vs ActivityPub-
   forum) and 3 different language stacks. But avoid letting "federation"
   tasks dominate the slate; cap at ~30% of total tasks.

6. **No additional repo needed** for L0/L1 stress-testing — Jellyfin
   StyleCop + Lemmy Rust types cover the high end. The earlier brainstorm
   suggestion of adding Grocy (no-framework PHP) for "convention-matching
   hard mode" is now optional.

## Open questions

- **Synapse 1,996 open issues** — how many are stale-from-archive vs
  actually live? Need a triage pass before mining for L2 task candidates.
- **HA contamination boundary** — exactly which task archetypes are safe?
  Need an explicit allow/deny list mapped against
  [home-assistant-datasets](https://github.com/allenporter/home-assistant-datasets).
- **Commit pinning** — pick a commit SHA per repo for the published
  benchmark to keep reproducibility. Frozen at first task-authoring date.
- **Live vs static** — if benchmark releases quarterly task drops, how do
  we handle Vaultwarden bus-factor risk? Possibly: maintain a backup
  corpus member (Gitea security PRs) ready to swap.

## Next steps

1. **Lock the name** — Constellation vs Homestead vs Stack vs BYO.
2. **Draft 5 sample tasks per layer per repo** (~240 task pilot before
   full release of ~480).
3. **Spec the ablation harness** — how docs/kata get injected, how
   scoring rolls up per-layer.
4. **Build the HA contamination allow/deny list** as part of task design
   methodology.
5. **Pin commit SHAs + dep lockfiles** for reproducibility.
6. **Write the methodology paper outline** — leaderboard, ablation
   results, per-layer Δ table is the headline figure.

## Sources cited inline

All claims sourced via inline URLs. Per-repo full source lists in agent
deep-dive transcripts (preserved in workflow session
`RE-49d8-0429`).
