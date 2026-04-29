# Renaming research — duraclaw → enterprise-credible brand

**Date:** 2026-04-28
**Author:** research session
**Type:** Brainstorming + naming/conflict research
**Status:** First-pass — produces a shortlist + conflict map; final pick needs human decision (and a domain/USPTO check)

---

## TL;DR

The README's positioning has moved well past the original "lobster-claw of
sessions" hero metaphor. Today it sells duraclaw as *"the harness layer
between an enterprise codebase and the agent SDKs / CLIs that work it"*
— centralized, auditable scaffolding for governed agent workflows. That
positioning needs a name a CIO / CISO can put in a procurement deck
without wincing. "duraclaw" reads as indie / playful, which is fine for
a hacker brand but actively works against the enterprise narrative the
README now leads with.

This doc:
1. States the problem and the constraints a new name has to satisfy.
2. Diverges across **six metaphor families** with ~50 candidates.
3. Reports **trademark / product-conflict findings** from web research
   (the "agent control plane" space is dense — Harness, Trellis,
   Conductor, Maestro, Vellum, Aegis, Echelon, Anvil, Helmsman are all
   already taken in adjacent or identical categories).
4. Converges on a **Tier-1 shortlist of 6 names** that survive both the
   positioning test and the conflict sweep, with a scored matrix.
5. Lays out the next-step checks (USPTO, .com / .ai, GitHub org, npm
   scope) — none of which are done here.

**Tier-1 shortlist (in rough order of fit):**

1. **Plinth** — structural-base metaphor, tight pairing with `baseplane`
2. **Capstan** — nautical control mechanism (orchestration-coded), no conflicts found
3. **Bridlepoint** — riffs on the README's own "harness" framing without colliding with Harness.io
4. **Buttress** — "support / reinforce", strong industrial register
5. **Forgewright** — coined, brandable, no conflicts found
6. **Bowline** — knot that holds without slipping, lightweight nautical

> **2026-04-29 update — pivot on user feedback.** *"Capstan sounds like
> a cap stand — no need to be literal, just needs to sound cool."* See
> [§8 — Sound-first round (v2)](#8-sound-first-round-v2) for the
> revised brainstorm that drops the "the metaphor must defend itself"
> constraint and optimizes purely for phonetic appeal in the
> Stripe / Linear / Vercel / Anthropic / Mistral school of brand naming.
>
> **Rounds 3–5 update — front-runner WAS Lockstep, now WITHDRAWN.**
> Three further rounds of tighter conflict checking eliminated the v2
> sound-first shortlist (Strake, Spire, Strider, Praetor, Cascade —
> all taken in AI dev tools). Lockstep briefly held the #1 spot on
> the criteria matrix.
>
> **Round 7 — Lockstep is DEAD.** Authoritative `whois` queries (the
> check that should have run before round 5's recommendation) revealed
> `lockstep.ai` is owned by Sage Software, Inc. — registered via
> MarkMonitor (the Fortune-500 brand-protection registrar) post-
> acquisition, locked across all three transfer/update/delete
> states. Same Cloudflare nameservers on `.dev` and `.app` indicate
> Sage holds the entire defensive software-TLD portfolio. GitHub
> `/lockstep` is taken by the original Lockstep team (now Sage).
> See [§8.11](#811-round-7-reality-check--lockstep-is-dead) for the
> walk-back and [§8.12](#812-methodology-lesson--whois-first-recommend-second)
> for the methodology lesson — web-search conflict checking cannot
> see corporate defensive holdings; whois must run BEFORE any rename
> recommendation.
>
> **Rounds 8–11 — Varni briefly held the recommendation.** After
> Lockstep died, rare-English-word fallbacks all compromised, coined
> Vercel-style words exhausted, phonotactic compounds mid-tier.
> User-flagged `varni.ai` was open with no AI/dev-tools conflict.
>
> **Round 12 — VARNI IS DEAD.** User caught what my searches missed:
> VARNI is a real Indian premium consumer electronics brand (Bluetooth
> speakers, mobile accessories, home automation), active since 2009,
> 20,000 dealers, retail presence on Amazon.in / Flipkart / Snapdeal,
> tagline *"A Proudly Indian Brand."* **Class 9 trademark collision** —
> consumer electronics and computer software share Class 9, so VARNI's
> mark blocks software/SaaS use. See
> [§8.18d](#818d-round-12--varni-walkback-consumer-electronics-conflict)
> for the kill and a methodology update (must search candidate name
> against *adjacent Class-9 product categories*, not just AI / dev
> tools — a Class-9 trademark holder in *any* product category can
> block software use).
>
> **Final rest state — recommendation: stay with duraclaw.** After
> twelve rounds the universe of available enterprise-credible AI brand
> names is effectively exhausted. Spinewright and Bridgehold remain as
> mid-tier fallbacks. Neither is clearly better than duraclaw in a way
> that justifies the 2-4 week migration + SEO loss + break-something
> risk + team context-switch. Datadog precedent: playful brand + great
> product is fine. Spend rebrand-budget engineering on shipping
> product instead. Revisit only if duraclaw the name actually loses a
> deal in the next quarter. See
> [§8.18e](#818e-final-rest-state--duraclaw-vs-fallbacks).

---

## 1. Why duraclaw doesn't fit the current positioning

**What the README now claims:**

- *"An AI-native code-orchestration platform — the harness for building with AI at scale"*
- *"Centralized, auditable scaffolding for enterprise agent workflows"*
- *"…enterprise technology orgs that need centralized, auditable scaffolding around their agent workflows…"*
- *"…mitigate the security and vendor-lock-in concerns that block AI adoption inside larger orgs"*
- Three flexibility axes: **automated agent progression** / **customized inference** / **multi-tiered deployment**
- Multi-driver (Claude / Codex / Gemini), multi-tenant model registries, identity catalog, audit log

**What the name currently signals:**

- "Dura-" + "claw" — a playful, animal-coded portmanteau
- The hero image is *"a lobster claw cradling a constellation of glowing terminal sessions"* — fun, but signals "indie tool" not "platform you'd put a regulated workload on"
- For comparison: enterprise dev-tooling brands tend toward abstract / structural / coined words (Datadog, Snowflake, Databricks, Vercel, Stripe, Hashicorp Terraform / Nomad / Consul, GitHub, GitLab). The few playful-animal names that work (Datadog) had to outgrow the name on the strength of the product. Picking that fight from day one is a tax we don't have to pay.

The product is good enough that the name is now load-bearing in a way
it wasn't when it was three concurrent Claude sessions on a VPS. **The
name needs to do work for procurement, not against it.**

## 2. Constraints a new name has to satisfy

| Constraint | Why |
|---|---|
| Reads enterprise-serious | CISO / CIO procurement decks, "auditable scaffolding" framing |
| Pronounceable on first read | Sales / support calls, conference talks |
| 1–3 syllables, ≤ 10 letters | Logo, favicon, CLI command, npm scope |
| Connotes structure / control / governance | Aligns with "harness", "scaffolding", "control plane" |
| Plays nicely with parent brand `baseplane-ai` | Same brand family — `baseplane` is structural / foundational, the new name should sit *above* that on the same metaphor axis |
| Not already a known dev-tools / AI-orchestration product | Hard requirement (see §4 conflict report) |
| `.ai` and / or `.com` plausibly available | Not validated in this doc — see §6 |
| No negative meaning in major locales | Check before commit |
| Doesn't rhyme with or pun on a competitor | E.g. avoid anything that reads as "Cursor-ish" |

A subtle constraint worth highlighting: **the parent org is
`baseplane-ai`**, and `baseplane` is itself an architectural / CAD
term — *"the foundational reference plane on which everything is built."*
That gives us a brand-family dividend if we pick a name from the same
structural-engineering vocabulary. Two coherent words ("Baseplane" +
"Plinth", or "Baseplane" + "Capstan") read as a deliberate brand
system; "Baseplane" + "Duraclaw" reads as two unrelated projects that
share an org.

## 3. Naming approaches — six metaphor families

Each family is annotated with: what it signals, candidate words,
quick-take pros / cons.

### 3.1 Structural-engineering vocabulary (matches parent brand)

> **Signal:** "We are the load-bearing structure above your codebase.
> Baseplane is the foundation; we are the framework."

| Word | Etymology | Reading | Notes |
|---|---|---|---|
| **Plinth** | Greek *plinthos* — base of a column | Foundational base block in architecture | Pairs perfectly with `baseplane`. Short, hard consonant cluster, brandable. **Tier-1.** |
| **Capstan** | Old French — vertical winch for ropes | Mechanical device for controlled tensioning of cables on a ship | Triple-meaning win: (a) literally a control mechanism, (b) the architectural top of a column ("capstone-adjacent"), (c) "what you grip to manage many lines at once." **Tier-1.** |
| **Buttress** | Old French *bouterez* — supporting structure | A reinforcing exterior structure | Strong industrial register; reads as "we make your AI workflow not collapse." **Tier-1.** |
| **Keystone** | Architecture — the central wedge that locks an arch | Indispensable central element | Heavily used in B2B SaaS; would need conflict check. |
| **Pylon** | Greek *pylōn* — gate / structural pillar | Vertical structural support | Crowded (Pylon CMS, etc.). |
| **Architrave** | The beam directly above a column | Beam above pillars | Beautiful but ~4 syllables, hard to spell. |
| **Spar** | A pole used as ship mast or aircraft wing | Structural beam | Short, clean, but Spar is also a European supermarket chain. |
| **Truss** | Old French — bundled framework | Triangulated structural framework | "Truss" sounds like "trust" — could be a feature or a bug. |
| **Lintel** | The horizontal beam over a doorway | Crossing element | Lovely word, slightly obscure. |

### 3.2 Harness / restraint / control (the README's own metaphor)

> **Signal:** "We're the bridle on the agent — the human-controllable
> apparatus you put on a powerful animal to make it useful."

The README literally uses "harness" — but **Harness.io is a major
CI/CD player (now with "Harness Agents" too)**, so we cannot brand on
that word. We can riff on the *adjacent* harness vocabulary.

| Word | Reading | Notes |
|---|---|---|
| **Bridle** / **Bridlepoint** / **Bridleworks** | The piece you put on a horse to steer it | Same metaphor as "harness", no Harness.io collision. "Bridlepoint" feels enterprise-named. **Tier-1.** |
| **Cinch** | The strap that secures a saddle | Short, hard, brandable; means "easy" in colloquial English (could fit a marketing tagline) |
| **Halter** | A simpler bridle without bit | Brand-clear in dev tools (a cattle-GPS company exists, different category) |
| **Tether** | A flexible line that limits range | Anchored autonomy — fits the "agent within bounds" framing. (Tether the stablecoin is a brand collision risk.) |
| **Yoke** | A wooden brace joining two oxen | Multi-driver framing (one yoke, multiple agents). Slightly archaic. |
| **Reins** | The lines a rider holds | Action-verb-y, but harder to brand as a noun |
| **Brace** | A reinforcing strap or beam | Cross-pollinates with the structural family |

### 3.3 Nautical / orchestration

> **Signal:** "We coordinate many things moving at once with deterministic
> control." (Kubernetes literally means "helmsman" in Greek — this is
> a well-trodden metaphor in infra branding.)

| Word | Reading | Notes |
|---|---|---|
| **Capstan** | (see §3.1) — also fits here |
| **Bowline** | A knot that holds without slipping under load | Strong "reliable connection" reading. **Tier-1.** |
| **Bulwark** | A defensive wall on a ship | Defense / governance reading |
| **Davit** | The crane on a ship that lowers boats | Spawn-and-launch metaphor — too obscure |
| **Mooring** | The lines anchoring a ship | "Where sessions tie up" — pretty but soft |
| **Rigging** | The full system of ropes / pulleys / cables on a ship | "We are the rigging for your agent fleet." Strong but generic. |
| **Helmsman** | The one who steers | Already taken — `seuros/helmsman` is an "Adaptive instruction server for AI coding agents" on GitHub. **Conflicted.** |
| **Conductor** / **Maestro** / **Trellis** | (Orchestration-adjacent) | All taken — see §4. |

### 3.4 Coined / portmanteau / abstract

> **Signal:** "We are a category of one. The name is a brand, not a word
> from the dictionary." (Vercel, Stripe, Plaid, Pulumi school.)

| Word | Construction | Notes |
|---|---|---|
| **Forgewright** | "Forge" + "wright" (one who builds with the forge) | Coined, evocative of craftsmanship, no conflicts. **Tier-1.** |
| **Loomwright** | Same construction with "loom" | "Weaver of agent threads" — pretty but Loom is a known brand |
| **Strand** | A single line in a rope / cable | Short, clean, somewhat generic |
| **Cordage** | The collective term for ropes on a ship | Group / fleet metaphor |
| **Vellum** | Parchment used for serious documents | Already a major AI workflow platform — **conflicted** |
| **Praxis** | Greek — practical action / methodology | Reads serious, good shape. Need USPTO check. |
| **Modus** | Latin — the way / method | Short, clean. Generic enough to need a suffix. |
| **Cipher** | A code / a key to a code | Suggests audit / encrypted provenance; Cipher Mining is taken in crypto |
| **Ratchet** | A mechanism that allows movement only one direction | Phase-progression metaphor (kata phases ratchet forward). Slightly mechanical. |

### 3.5 Audit / governance / provenance

> **Signal:** "Every session, every tool call, every gate is logged and
> replayable." (The README leads with this.)

| Word | Notes |
|---|---|
| **Annal** / **Chronicle** | Chronicle taken (Google Chronicle for SecOps) |
| **Ledger** | Strong fit, but Ledger is a hardware-wallet brand collision |
| **Codex** | Fits exactly, but **OpenAI owns this name** in this category. Hard no. |
| **Foliant** | Old word for a heavy ledger / volume | Obscure but available |
| **Atlas** | A book of records / maps | Crushed — MongoDB Atlas, Atlas obs, etc. |
| **Provenance** | The full term for what we track | Long for a brand; Provenance is also a blockchain |

### 3.6 Fleet / cohort / many-things

> **Signal:** "Many concurrent sessions across worktrees, on web and
> Android — all coordinated."

| Word | Notes |
|---|---|
| **Armada** | Military fleet | Strong but combative |
| **Flotilla** | A small fleet | Lighter; brandable |
| **Cohort** | A group moving together | Heavily used in HR / education software |
| **Convoy** | A protected group | Convoy Inc. (logistics) is a brand |
| **Echelon** | A formation of rows | **Echelon (AI-assisted enterprise software dev platform, $4.75M seed Oct 2025) is in the same category. Conflicted.** |
| **Squadron** | A military formation | Combative reading |

## 4. Conflict report (web research, April 2026)

This is the most important section. The "agent control plane" /
"agent harness" category exploded in late 2025 / early 2026 (Google's
Gemini Enterprise Agent Platform at Cloud Next 2026, Microsoft Agent
365, AWS Bedrock AgentCore). Names get taken fast.

**Hard conflicts — do not use:**

| Name | Conflict | Source |
|---|---|---|
| **Harness** | Harness.io — major CI/CD platform with "Harness Agents" AI product | [Harness Developer Hub](https://developer.harness.io/docs/platform/harness-ai/harness-agents/) |
| **Trellis** | Trellis AI (YC, $500K) — tagline literally **"The best agent harness"**. Plus Sprout Social Trellis, Microsoft TRELLIS.2, Trellis 3D. Same category, same positioning. | [github.com/mindfold-ai/Trellis](https://github.com/mindfold-ai/trellis), [PitchBook](https://pitchbook.com/profiles/company/590553-37) |
| **Conductor** | conductor-oss — "event driven agentic orchestration platform … durable execution engine for AI Agents" (Apache 2.0) | [github.com/conductor-oss/conductor](https://github.com/conductor-oss/conductor) |
| **Maestro** | UiPath Maestro (BPMN agent orchestration), plus Maestro mobile testing framework | [Conductors to Orchestrators](https://www.oreilly.com/radar/conductors-to-orchestrators-the-future-of-agentic-coding/) |
| **Vellum** | Vellum AI — major AI workflow / agent automation platform | [vellum.ai blog](https://www.vellum.ai/blog/top-ai-agent-frameworks-for-developers) |
| **Aegis** | Aegis AI — *"The Agent Control Plane for Enterprise AI"* (literal positioning collision) | [aegisplatform.ai](https://aegisplatform.ai/) |
| **Echelon** | Echelon — emerged from stealth Oct 2025 with $4.75M, *"AI-assisted enterprise software developer platform … using AI agents"* | [Business Wire](https://www.businesswire.com/news/home/20251009239309/en/Echelon-Emerges-from-Stealth-to-Automate-Enterprise-IT-Services-and-Implementation-with-AI-Agents) |
| **Helmsman** | seuros/helmsman — *"Adaptive instruction server for AI coding agents"* on GitHub | [github.com/seuros/helmsman](https://github.com/seuros/helmsman) |
| **Anvil** | Anvil.works — major Python web app builder, plus useanvil.com (document SDK) | [anvil.works](https://anvil.works/) |
| **Codex** | OpenAI Codex CLI — duraclaw literally ships an adapter for it | (in repo) |
| **Bedrock** | AWS Bedrock — primary AI service brand | (well-known) |
| **Atlas** | MongoDB Atlas + many others | (well-known) |
| **Crucible** | Crucible AI (GitHub org), Crucibleforge (AI coding challenges) | [github.com/crucible-ai](https://github.com/crucible-ai) |
| **Conduit** | Multiple including a Discord-alternative chat platform | (search) |
| **Lattice** | Lattice (HR SaaS) | (well-known) |
| **Substrate** | Polkadot Substrate (blockchain runtime) | (well-known) |

**Soft conflicts — usable but with adjacent name in the wild:**

| Name | Conflict | Risk |
|---|---|---|
| **Mantle** | Mantle Technology (blockchain-as-a-service for finance / health / legal) | Different category, low risk in dev-tools. Tolerable. |
| **Stratum** | Stratum — managed cloud operations provider | Different category, generic word. Tolerable. |
| **Rivet** | Rivet — people / projects / assets management portal | Generic word, somewhat conflicted. |
| **Cipher** | Cipher Mining (crypto), various security products | Crowded but no agent-orchestration product. |
| **Tether** | Tether stablecoin (huge brand) | Too crowded. |
| **Loom** | Loom video, defunct Loom decentralized identity | Crowded, not safe. |

**Cleared in current search (no notable conflict in dev-tooling / AI-orchestration):**

- Plinth, Buttress, Bridle / Bridlepoint / Bridleworks, Cinch, Halter,
  Yoke, Capstan, Bowline, Bulwark, Davit, Mooring, Rigging, Forgewright,
  Loomwright, Cordage, Strand, Foliant, Modus, Praxis, Ratchet,
  Architrave, Lintel, Truss

**Reminder:** "no notable web result" ≠ "trademark-clear." See §6.

## 5. Tier-1 shortlist with scoring

Six candidates that survive the positioning test and the conflict
sweep, scored on the constraints in §2. Scores are 1–5 (5 = best fit).

| Candidate | Enterprise read | Parent-brand fit | Pronounce-ability | Conflict risk (5 = clear) | Distinctiveness | Total |
|---|---:|---:|---:|---:|---:|---:|
| **Plinth** | 5 | 5 (matches `baseplane` directly) | 4 | 5 | 4 | **23** |
| **Capstan** | 5 | 5 (architectural + nautical) | 5 | 5 | 4 | **24** |
| **Bridlepoint** | 4 | 3 | 4 | 5 | 4 | **20** |
| **Buttress** | 4 | 5 | 5 | 5 | 3 | **22** |
| **Forgewright** | 4 | 3 | 3 (compound) | 5 | 5 (coined) | **20** |
| **Bowline** | 4 | 4 (nautical sibling) | 5 | 5 | 4 | **22** |

### Picks, with positioning sentences

> **Capstan** — *"Capstan is the control plane for AI coding at scale —
> the mechanism that lets one operator manage many agents under tension,
> with full audit trail."* The capstan is literally a winch for
> coordinating ropes / cables on a ship; it's the metaphor a hardware
> engineer reaches for when describing controlled multi-line orchestration.
> Pairs naturally with `baseplane` (both come from heavy-engineering
> vocabulary). My top pick on points.

> **Plinth** — *"Plinth is the foundation block for enterprise AI
> coding."* The literal architectural meaning is "the base on which a
> column stands" — i.e. the load-bearing block under the structure. The
> brand-family pairing with `baseplane` ("the foundational reference
> plane") is unusually tight. Slightly less metaphorically rich than
> Capstan but more *obviously structural*.

> **Buttress** — *"Buttress reinforces your codebase against
> ungoverned AI."* Tracks well with the README's "scaffolding for
> security and vendor-lock-in concerns" framing. Strong industrial
> register. Less distinctive than Plinth / Capstan because "buttress" is
> a known English word in normal use.

> **Bowline** — *"The bowline holds under load and never slips."* A
> bowline is the knot sailors trust to hold a load without binding —
> a beautiful metaphor for "session that survives gateway restart and
> Worker redeploy." Slightly nautical-coded, which the parent brand isn't.

> **Bridlepoint** — Riffs on the README's own "harness" language
> without colliding with Harness.io. "Bridle" alone is short and clean
> but might read as horse-tack-only; "Bridlepoint" reads as a place /
> brand. Lower parent-brand alignment.

> **Forgewright** — Fully coined, brandable like Vercel. *"The
> forgewright builds the structures the agents work in."* Highest
> distinctiveness, but compound names are harder to land in
> conversation and on logos.

## 6. What this doc does NOT do

- **Trademark search.** We've done a web-conflict sweep, not a USPTO /
  EUIPO / WIPO check. Before committing, run each Tier-1 candidate
  through:
  - USPTO TESS, classes 9 (software) and 42 (SaaS / hosted services)
  - EUIPO eSearch
  - GitHub org availability
  - npm scope availability (`@plinth`, `@capstan`, etc.)
  - .com, .ai, .dev, .io domain availability and squatter pricing
- **Linguistic / locale check.** Verify no negative meanings in
  Mandarin / Spanish / French / German / Japanese (the largest
  enterprise markets).
- **Logo / typeface vibe check.** Brandable in lowercase as a CLI?
  Distinctive at favicon size? Both apply more to Forgewright and
  Bridlepoint than to the short single-syllable picks.
- **Migration cost.** A rename touches everything: GitHub org / repo,
  npm packages, Workers script names, R2 bucket names, D1 database
  names, Better Auth configuration, the Capacitor app ID
  (`ai.baseplane.duraclaw` → ?), the documented hostnames in install
  scripts, etc. That's an implementation spec, not research. The
  README's `<!-- README design notes -->` comment is the right place to
  start enumerating it.

## 7. Recommendation

If a single name is needed today, my recommendation is **Capstan** —
it scores highest, the metaphor is unusually rich (it's literally a
control device), it pairs naturally with `baseplane` on the
heavy-engineering brand axis, and the conflict sweep is clean. **Plinth**
is the safer, more conservative second choice — tighter parent-brand
fit, slightly less expressive metaphor.

If the priority is *avoiding any English dictionary word entirely*
(some enterprise brands prefer this — Vercel, Stripe, Pulumi —
because the brand owns 100% of the search results), then
**Forgewright** is the coined option to check next.

**Recommended next step:** run §6's trademark / domain / npm checks on
**Capstan** and **Plinth** in parallel. If both clear, do a quick
informal poll inside @baseplane-ai before kicking off the rename spec.

---

## Sources

- [Harness Agents | Harness Developer Hub](https://developer.harness.io/docs/platform/harness-ai/harness-agents/)
- [github.com/mindfold-ai/Trellis — "The best agent harness"](https://github.com/mindfold-ai/trellis)
- [Trellis AI 2026 Company Profile | PitchBook](https://pitchbook.com/profiles/company/590553-37)
- [conductor-oss/conductor — agentic orchestration platform](https://github.com/conductor-oss/conductor)
- [Conductors to Orchestrators: The Future of Agentic Coding | O'Reilly](https://www.oreilly.com/radar/conductors-to-orchestrators-the-future-of-agentic-coding/)
- [Vellum AI — top AI agent frameworks blog](https://www.vellum.ai/blog/top-ai-agent-frameworks-for-developers)
- [Aegis AI — The Agent Control Plane for Enterprise AI](https://aegisplatform.ai/)
- [Echelon Emerges from Stealth | Business Wire (Oct 2025)](https://www.businesswire.com/news/home/20251009239309/en/Echelon-Emerges-from-Stealth-to-Automate-Enterprise-IT-Services-and-Implementation-with-AI-Agents)
- [Agent Harness Engineering — The Rise of the AI Control Plane | Adnan Masood, Apr 2026](https://medium.com/@adnanmasood/agent-harness-engineering-the-rise-of-the-ai-control-plane-938ead884b1d)
- [Google Cloud Next 2026: The Agentic Enterprise Control Plane | Bain](https://www.bain.com/insights/google_cloud_next_2026_the_agentic_enterprise_control_plane_comes_into_view/)
- [The Enterprise AI Control Plane | Epsilla](https://www.epsilla.com/blogs/enterprise-ai-agent-trends-1328)
- [seuros/helmsman — Adaptive instructions for AI coding agents](https://github.com/seuros/helmsman)
- [anvil.works — Python web app builder](https://anvil.works/)
- [Crucible AI · GitHub](https://github.com/crucible-ai)
- [Baseplane.ai — construction software (parent-brand collision note)](https://baseplane.ai/)

---

## 8. Sound-first round (v2)

> **Feedback that triggered this round:** *"Capstan sounds like a cap
> stand — no need to be literal, just needs to sound cool."*

The v1 brainstorm above is metaphor-driven — every candidate has to
"defend itself" against the positioning (harness, scaffolding, control
plane, governance). That filter rules out most cool-sounding brands by
construction: Vercel, Stripe, Linear, Anthropic, Mistral, Plaid,
Pulumi, Cohere don't *mean* anything literal in their categories
either. They just sound like brands.

This section drops the must-defend-itself filter and optimizes purely
for phonetic appeal, brandability, and conflict-clearance.

### 8.1 What "sounds cool" actually means in dev-tool branding

Looking at brands that landed in the AI / dev-tool category recently
without justifying themselves through metaphor:

- **Stripe, Plaid, Linear, Cursor** — short, sharp, single-flow
- **Vercel, Pulumi, Anthropic, Cohere** — Latin / Greek root that
  *sounds* modern; doesn't translate literally into the product
- **Mistral, Polaris, Atlas, Polaris** — celestial / weather names with
  scale connotation (most are taken)
- **Bolt, Cursor, Linear, Sentry** — single-word verb / noun

Sound qualities that consistently work:
- **Hard consonants** to start: k-, t-, p-, st-, str-, kr-, pr-
- **Open vowels** in the body: a, o
- **One or two syllables**, ideally read as a single phonetic unit
  (this is the rule "Capstan" violated — it parses as "cap" + "stan")
- **No internal morpheme boundary** that the ear can split on first
  hearing
- **Latin / Greek / Slavic root** is fine — modern brand-feel without
  being made-up gibberish

### 8.2 v2 candidate pool — sound-first

Cleared of conflicts at the dev-tools / AI level (see §8.3 for the
sweep):

| Candidate | Syllables | Read | Brand vibe |
|---|---|---|---|
| **Strake** | 1 | strayk | Sharpest single-syllable in this list. Looks like Stripe meets Drake. Aerospace / shipbuilding term but not common-knowledge — reads as a brand, not a word. |
| **Spire** | 1 | spy-r | Vertical, structural, rises *above* something — natural pairing with `baseplane` (foundation → spire). Short, clean. |
| **Tempest** | 2 | TEM-pest | Classical, dramatic, recognizable. Reads as scale and intensity without being aggressive. |
| **Strider** | 2 | STRY-der | Action-coded, hard consonants. Slight LOTR shadow but generic enough that it doesn't dominate. |
| **Praetor** | 2 | PRAY-tor | Roman magistrate / authority — governance-coded without being heavy-handed. Distinctive. |
| **Cinder** | 2 | SIN-der | Forge-adjacent imagery without colliding with Ember.js. Soft enough to balance the rest of a hard brand. |
| **Verge** | 1 | vurj | Edgy, "the verge of"-coded. *The Verge* is a media brand but in a different category. |
| **Stark** | 1 | stark | Severe, clean, stripped-down. **Heavy cultural baggage** (Iron Man / GoT) — caveat. |
| **Slate** | 1 | slayt | Material-coded, blank-canvas reading. Slate Magazine + Slate Auto exist but neither in dev tools. |
| **Quartz** | 1 | kwartz | Crystalline / structural, mineral-coded. *Quartz* business-news brand exists. |

Coined / Vercel-school options worth a USPTO check:

| Coined word | Construction | Read |
|---|---|---|
| **Stratos** | Greek-feeling, "stratosphere" root | STRA-toss — clean, scale-coded |
| **Veridian** | Latinate "green / verdant" feel | ver-RID-ee-an — three syllables, tech-modern |
| **Solex** | "Sol" + "ex" suffix | SO-lex — short, slick |
| **Korridor** | "Corridor" with K | KOR-ee-dor — Slavic edge |
| **Sintra** | Place name (Portugal) | SIN-tra — clean, Iberian |
| **Velnir** | Coined | VEL-neer — Norse-feel |

### 8.3 Conflict sweep — round 2

**Hard conflicts surfaced this round:**

| Name | Conflict | Source |
|---|---|---|
| **Halcyon** | Halcyon.ai — *unicorn* anti-ransomware platform ($209M raised, $1B valuation, 524 employees). Owns the "Halcyon AI" brand in security. | [halcyon.ai](https://www.halcyon.ai/) |
| **Kairos** | **Worst-case conflict.** Anthropic's *unreleased* internal Claude Code daemon mode is literally codenamed **KAIROS** (autonomous "autoDream" feature, leaked via npm unminified bundle March 31, 2026). Plus kairos.computer (AI agent platform), kairos.com (identity verification), kairos-project.org (AI safety). | [Street Insider](https://www.streetinsider.com/Press+Releases/Claude+Code+Leak+Reveals+KAIROS:+Anthropic%E2%80%99s+Unreleased+Persistent+AI+Agent+Raises+Questions+About+the+Future+of+AI+Memory/26281658.html), [Agent-Kairos Medium](https://medium.com/data-and-beyond/agent-kairos-8c42538c240a) |
| **Telos** | Telos 2.0 — AI Agent for Unreal Blueprints (Aura AI / Ramen). Plus Telos blockchain. | [Games Press](https://www.gamespress.com/en-US/Next-Evolution-of-Best-In-Class-Multi-agent-AI-Assistant-for-Unreal-En) |
| **Onyx** | onyx.app — open-source AI platform for enterprise search ($10M raised, First Round + Khosla). Adjacent category. | [onyx.app](https://onyx.app/) |
| **Cobalt** | Cobalt AI — data infrastructure for AI labs (Feb 2026 launch). Plus Cobalt.io (pen-testing). | [Business Wire](https://www.businesswire.com/news/home/20260217348798/en/Cobalt-AI-Launches-Advanced-Data-Infrastructure-for-AI-Labs) |
| **Polaris** | Atos Polaris AI Platform — *"enterprise-grade autonomous AI agents"* on AWS Marketplace. Direct collision. | [AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-5hs53x6h5xtyq) |
| **Crux** | Crux (YC W24) — *"Decision-Making AI Copilot for Enterprises"* ($2.6M seed). Direct collision. | [TechCrunch](https://techcrunch.com/2024/02/08/crux-is-building-genai-powered-business-intelligence-tools/), [Crunchbase](https://www.crunchbase.com/organization/crux-ai) |
| **Granite** | IBM Granite — IBM's coding LLM family with Granite.Code VS Code extension. | [IBM Granite](https://www.ibm.com/granite) |
| **Vega** | Vega Minds — AI agents for firm-knowledge retrieval. Vega IT consultancy. | [Vega Minds Help](https://help.vegaminds.com/en/articles/10050475-vega-s-ai-agents) |
| **Vesper** | vesper-ai.vercel.app + Vesper crisis-response mobile platform. Soft conflicts but real. | (search) |
| **Lodestar** | Lodestar (computer-vision dataset platform) — permanently closed but trademark may linger. | [Lodestar docs](https://docs.lodestar.ai/), [Crunchbase](https://www.crunchbase.com/organization/lodestar-ae84) |

**Cleared in dev-tools / AI category (no notable conflict found):**

- **Strake**, **Spire**, **Tempest**, **Strider**, **Praetor**,
  **Cinder**, **Verge AI**, **Stark AI**, **Slate**, **Quartz**, **Lyra**,
  **Stratos**, **Veridian**, **Sintra**

(Reminder: clear in web search ≠ trademark-clear. USPTO TESS, EUIPO,
domain, and npm scope checks are still §6 next-step work.)

### 8.4 v2 Tier-1 — sound-first picks

Top five from this round, scored on the v2 criteria (sound, brand
distinctiveness, conflict-clearance, parent-brand fit, length):

| Candidate | Sound | Brand distinct. | Conflict (5 = clear) | `baseplane` fit | Length | Total |
|---|---:|---:|---:|---:|---:|---:|
| **Strake** | 5 | 5 | 5 | 4 (structural) | 5 (1 syl) | **24** |
| **Spire** | 5 | 4 | 5 | 5 (foundation→spire) | 5 (1 syl) | **24** |
| **Tempest** | 5 | 4 | 5 | 3 | 4 (2 syl) | **21** |
| **Praetor** | 4 | 5 | 5 | 3 | 4 (2 syl) | **21** |
| **Strider** | 4 | 4 | 5 | 3 | 4 (2 syl) | **20** |

### 8.5 Recommendation (revised — but see §8.6 round-3 kills)

> **Top pick: Strake.** Single syllable, sharp consonants, no
> conflicts, novel enough to dominate its own search results, looks
> good in lowercase as a CLI command (`strake login`). Sounds like a
> peer of Stripe / Drake / Slate without colliding with any of them.

> **Close second: Spire.** Pairs with `baseplane` on the structural
> axis (foundation → spire) without being literal about it. Clean,
> short, conventionally pretty. Slightly less distinctive than Strake
> because "spire" is a known English noun.

> **⚠️ Both top picks were killed in round 3.** See §8.6.

### 8.6 Round-3 conflict sweep — sound-first list collapses

Tighter searches (without phrase quoting that hid close matches in
rounds 1–2) wiped out almost every v2 candidate. The lesson: the AI
dev-tooling naming space in April 2026 is essentially exhausted for
short English words with hard consonants. Sloppy round-1/2 searches
hid these conflicts because they were filtered to exact phrase matches.

| Name | Killed by | Source |
|---|---|---|
| **Strider** | **Strider Technologies / Strider OS** — *"agentic operating system, a centralized intelligence orchestration layer"* (literal positioning collision). Available on AWS Marketplace, offices in 5 countries, AI-powered strategic intelligence platform. | [striderintel.com](https://www.striderintel.com/), [Strider OS launch](https://www.prnewswire.com/news-releases/strider-launches-agentic-operating-system-to-power-next-generation-of-strategic-intelligence-302750846.html) |
| **Strake** | **strake.dev** — active *"SRE Intelligence Platform for engineering teams without dedicated SRE coverage"* (directly adjacent dev-tools category). Plus Strake Inc. (OTC: SRKE) pivoted to AI. Plus Straiker AI ($21M, agentic-first AI security) contaminates the phonetic namespace. Plus Strac (DLP platform). | [strake.dev](https://strake.dev/), [Strake Inc. ticker](https://www.tennesseedaily.com/news/274015566/strake-inc-otc-srke-marks-new-beginnings-with-ticker-symbol-transition-and-bold-leap-into-ai), [Straiker.ai](https://www.straiker.ai/blog/straiker-launches-with-21-million-to-safeguard-ai) |
| **Spire** | **Spire.AI** — $68.8M raised (14 rounds, 56 investors), Knowra "Context Intelligence platform", launched **Agent Sigma** (autonomous AI agent for talent supply chain) in April 2025. Plus Spire Global (satellite weather data), Spire Technologies (Bahrain fintech), Spire Inc (utility). The `.ai` domain is gone with serious capital behind it. | [spire.ai](https://spire.ai/), [G2 reviews](https://www.g2.com/products/spire-ai/reviews) |
| **Praetor** | **Wolters Kluwer Praetor AI** for legal (Word add-in); **Praetorian.com** offensive-security firm with a GitHub org. Both adjacent. | [Wolters Kluwer Praetor](https://www.wolterskluwer.com/en/solutions/praetor/praetor-ai), [praetorian.com](https://www.praetorian.com/) |
| **Tempest** (downgraded) | **Tempest AI** (Sydney, AI game creation platform, seed-funded by Galileo Ventures); **tempest.energy** project management. Different categories from coding tools, but the `.ai` is taken. **Survivable but contaminated.** | [Tempest AI on PitchBook](https://pitchbook.com/profiles/company/756073-81), [Tempest AI LinkedIn](https://www.linkedin.com/company/tempest-ai) |

**Survivors from v2 after round 3:** essentially none. Tempest is the
only one still standing, and it's compromised on the .ai domain.

### 8.7 Recalibrated recommendation

The pure "short, sharp, single English word" naming strategy has run
out of runway in this category. What's left as actually-clear candidates
across all three rounds:

**From v1 (metaphor-driven, but cleared):**
- **Plinth**, **Bowline**, **Buttress**, **Bridlepoint** — all cleared
  in round 1 and not surfaced as conflicts since. Tighter brand-family
  fit with `baseplane` than the v2 sound-first picks.
- **Forgewright** — coined / Vercel-school, fully cleared.

**Strategic options going forward:**

1. **Pivot to coined / made-up words.** Vercel, Stripe, Pulumi, Plaid
   each own ~100% of their search results because the word didn't
   exist before they did. Candidates worth a USPTO check:
   - **Stratos** (Greek "layer", scale-coded) — already used by some
     small entities, needs verification
   - **Veridian** / **Veridia** (Latinate, green-tech feel)
   - **Korridor** (corridor-with-K, Slavic edge)
   - **Solex**, **Velnir**, **Sintra** — fully invented
   - **Forgewright** — still standing from v1

2. **Lean into the obscure-English-word strategy.** Words where
   duraclaw can own the search results because nobody uses them:
   - **Plinth**, **Bowline**, **Buttress** — known but rare in tech
   - **Architrave**, **Lintel**, **Foliant**, **Strake** (killed),
     **Davit**

3. **Stop trying to be enterprise-default.** Datadog, Snowflake, and
   GitHub all have non-enterprise names that won. The original
   `duraclaw` problem is not unsolvable by name alone — a strong
   product + strong narrative can carry a playful name. If a rename
   isn't going to clear conflicts comfortably, **the option of doing
   nothing** is the comparison case the user should weigh against any
   pick that requires a trademark fight.

### 8.8a Round-4 — Cascade and motion-coded family

User's gut picks (Strider, Cascade) revealed a pattern: **motion /
flow / capability-coded names** with verb-energy. Round 4 sweeps
that family.

| Name | Killed by |
|---|---|
| **Cascade** | **Windsurf Cascade** — Windsurf's flagship agentic AI coding agent. Windsurf was acquired by Cognition (Devin team) for ~$250M in Dec 2025; ranks #1 in LogRocket AI Dev Tool Power Rankings as of Feb 2026; $82M ARR, 350+ enterprise customers. Plus gocascade.ai (enterprise workflow), usecascade.ai (sales pipeline), try-cascade.ai ("AI-Native Initiative-to-Execution Platform"). Cascade is the *literal flagship product* of duraclaw's nearest direct competitor. **Worst possible conflict.** |
| **Stride** | stride.build — *"Agentic AI Solutions / Custom AI Agents for Enterprise"* (exact category). Plus Microsoft STRIDE threat-modeling framework. Plus former Atlassian Stride chat product. |
| **Surge** | Surge AI — well-known data-labeling company used by OpenAI / Anthropic. Hard kill. |
| **Rally** | Rally Software → Broadcom-owned project management. |
| **Vanguard** | Vanguard funds — too dominant to share an audience with. |
| **Harbinger** | harbinger.ai + Harbinger Group's "Agentic AI Studio" with AI Excellence Awards 2026. |
| **Slipstream** | No dominant AI conflict, but Slipstream Communications / Slipstream Media in adjacent marketing space. Survivable. |
| **Throughline** | No notable AI/dev-tools conflict. Three syllables, less brandable, but **clear**. |
| **Lockstep** | Lockstep accounting is a real B2B brand but in a different category. Survivable. |

**Cascade reflection:** the pattern of the user's two gut picks
(Strider, Cascade) shows the deeper problem — *every* name with
"agentic energy" already has an AI company on it. The naming gold rush
of late 2025 / early 2026 has consumed the verb-coded vocabulary in
the same way it consumed the structural-noun vocabulary in rounds 1–3.

### 8.9 Round-5 — Lockstep re-evaluation (the one we missed)

User pushback: *"Lockstep has nothing in AI and a bunch of random
stuff."* Correct. Round 4 dismissed Lockstep as "soft conflict" — that
was wrong. Tighter sweep:

**What's actually on "Lockstep":**
| Holder | What | Status |
|---|---|---|
| Lockstep (accounting) | Connected-accounting SaaS | **Acquired by Sage Group, announced Aug 2022, closed 2024 — absorbed into Sage Network, brand fading** |
| lockstep.io | Unity / Node.JS networking library (game-dev "lockstep simulation" pattern) | Hobby project |
| getlockstep.io | Audit management tool | Niche |
| Lockstep VC | Venture firm | Unrelated |
| **AI coding / agent orchestration / dev tools** | — | **Open. Category is clear.** |

**Trademark logic:** financial-services class (Sage / accounting
Lockstep) doesn't block AI / SaaS class. The Sage acquisition is a
*positive* — the standalone Lockstep brand is fading.

**Lockstep on its merits:**

| Test | Score |
|---|---|
| Sound — "LOK-step", 2 syllables, hard consonants, single phonetic unit | 5 |
| Verb-energy / motion-coded (matches user's Strider/Cascade gut) | 5 |
| Enterprise read — disciplined, governed, controlled | 5 |
| Parent-brand fit with `baseplane` | 4 — coherent: foundation provides surface, lockstep is how things move on it |
| Distinctiveness — owns its search results in AI | 5 — no AI competitor |
| CLI ergonomics — `lockstep enter implementation` | 5 |
| Conflict in our category | 5 — clear |
| `.ai` domain likely available | 4 — needs WHOIS |
| **Total** | **38 / 40** |

**Positioning sentence writes itself:**

> *"Lockstep is the harness for enterprise AI coding — every agent,
> every tool call, every gate moving in lockstep with your policy."*

**Revised top pick: Lockstep.** First candidate across five rounds
that hits every criterion: sound, verb-energy, enterprise read,
conflict-clear, parent-brand-coherent, CLI-friendly. The accounting-
Lockstep absorption into Sage means the standalone trademark space in
software is in better shape than any other candidate we've reviewed.

**Next-step checks specifically for Lockstep:**
- USPTO TESS class 9 (software) and class 42 (SaaS) — verify Sage
  isn't holding the class 9/42 mark as part of the acquisition.
  **Critical gate.** Sage's accounting product was class 35/36; if
  defensive marks were filed across class 9/42 during the deal, the
  whole strategy collapses regardless of domain availability.
- EUIPO eSearch
- WHOIS on `lockstep.ai`, `lockstep.dev`, `lockstep.app`,
  `lockstep.so`, `lockstep.to`
- GitHub `lockstep` org availability (currently `Lockstep-Network` is
  the accounting / Sage org — different name, low collision risk)
- `npm` `@lockstep` scope availability
- Locale check (no obvious negative meanings in Mandarin / Spanish /
  French / German / Japanese — verify)

### 8.10 Domain strategy (round 6)

User intel: *"lockstep.ai taken but not used — could probably buy down
the road. There's .to and .so."*

Strategy recommendation: **launch on `lockstep.so`, acquire
`lockstep.ai` early (not later), defensively register `.dev` and
`.app`, skip `.to`.**

**TLD comparison for an enterprise dev-tooling brand in 2026:**

| TLD | Vibe | Enterprise read | Notable lineage |
|---|---|---|---|
| **`.so`** | Dev-credible, "the startup TLD before .com" | Survives procurement deck | Notion (notion.so), early Linear, many YC startups |
| **`.ai`** | Prestige TLD for AI companies | Strongest signal | Anthropic, Perplexity, etc. |
| **`.to`** | Indie / shortener / pirate-leaning | Eyebrow-raise from CISO | URL shorteners, file-share sites |
| **`.dev`** | Google-controlled, dev-coded | Neutral / docs-flavored | Defensive register only |
| **`.app`** | Google-controlled, product-coded | Neutral / app-flavored | Defensive register only |
| **`.com`** | **Owned by Sage** (accounting Lockstep) | N/A | Trademark blocked |
| **`.io`** | Hobby Unity networking lib | Negligible, low collision risk | Skip |

**Phonetic accident:** `lockstep.so` reads as *"lockstep, so [therefore]"*
— the TLD completes a logical conjunction. `lockstep.to` reads as
*"lockstep to"* — preposition without object, incomplete.

**Acquisition timing logic for `lockstep.ai`:**

> Buy early, not "down the road." Brand equity creates demand;
> demand creates price escalation.

Pricing dynamics for parked `.ai` domains on real English words in
April 2026:
- **Now (pre-launch, no brand equity):** generic inquiry, typical
  asking $15K–$40K, often negotiable to ~half
- **Post-launch (you're "Lockstep"):** owner Googles → identifies
  buyer → asking 3–4× as Lockstep starts appearing in search results
  and press

Recommended outreach play: anonymous broker (Squadhelp / Sedo /
GoDaddy Domain Brokers), do not link buyer identity, set $20–50K
budget envelope. Launch on `.so` regardless of outcome — gives
optionality and resilience, lets you walk away from a price-gouging
seller. Migrating from `.so` to `.ai` later is cheap (DNS + 301s);
losing leverage by signaling "Lockstep AI" is expensive.

**Defensive registrations to do immediately on rename approval:**
`lockstep.so` (launch), `lockstep.dev`, `lockstep.app`, GitHub
`@lockstep` org, `npm` `@lockstep` scope, social handles.

### 8.11 Round-7 reality check — Lockstep is DEAD

**Walk-back of the round 5/6 recommendation.** Authoritative whois
queries (run via `whois`/`dig` from the dev shell) reveal the Sage
Lockstep brand is *actively defended*, not absorbed. The narrative
that the standalone Lockstep brand was "fading" was wrong.

**Confirmed via WHOIS (2026-04-29):**

```
lockstep.ai
  Registrant Organization: Sage Software, Inc.
  Address: 271 17th Street NW Suite 1100, Atlanta, GA  ← Sage US HQ
  Email: dnsadmin@sage.com
  Registrar: MarkMonitor Inc.  ← Fortune-500 brand-protection registrar
  Created: 2023-05-05 (POST-acquisition)
  Expires: 2027-05-05
  Status: clientDeleteProhibited / clientTransferProhibited / clientUpdateProhibited
```

`lockstep.dev` and `lockstep.app` resolve to the same Cloudflare
nameservers (`elaine.ns.cloudflare.com` / `terin.ns.cloudflare.com`)
as `lockstep.ai` — almost certainly the same Sage portfolio.
`lockstep.com` is locked under `clientRenewProhibited` since 2022 —
classic corporate-asset lock pattern. **GitHub `/lockstep`** = "Lockstep
Labs" (original accounting team, now Sage), HTTP 200, taken.

**What this means:**

1. Sage actively defends the Lockstep trademark across software TLDs.
2. MarkMonitor + post-acquisition .ai registration = the pattern of a
   company with — or pursuing — class 9/42 software-mark filings.
3. `.so` and `.to` *being* available is irrelevant when the brand
   itself is corporate-owned and defended.
4. A duraclaw → Lockstep rebrand in software/SaaS would draw a Sage IP
   C&D within months. Not survivable.

**Lockstep is dead. Same kill-mechanism as Cascade — owned and
defended by a competitor.** Round 5/6 recommendation withdrawn.

### 8.12 Methodology lesson — whois first, recommend second

Three of my round-5/6 confidence statements were **demonstrably wrong**
the moment authoritative whois was run:

| Claim (round 5/6) | Reality (round 7) |
|---|---|
| "Sage absorbed Lockstep, brand fading" | Sage actively defends Lockstep with MarkMonitor + post-acquisition .ai registration |
| "lockstep.ai is parked, could be bought down the road" | Owned by Sage HQ via brand-protection registrar; not for sale |
| "Standalone Lockstep namespace is open" | Sage holds .ai / .dev / .app / .com + GitHub org |

Web-search-only conflict checking is **insufficient** for a real
brand decision. The cheap-and-fast checks that should run BEFORE
recommending any name as the front-runner:

1. `whois <name>.com / .ai / .dev / .app / .io / .so` — see who owns
   each TLD and via which registrar (MarkMonitor / CSC / Brand
   Cybersecurity = corporate brand defense, big red flag)
2. `dig <name>.<tld> NS` — same nameservers across multiple TLDs ≈
   same owner, defensive portfolio
3. `curl -s -o /dev/null -w "%{http_code}\n" https://github.com/<name>`
4. USPTO TESS query for the bare word in classes 9 / 42
5. Sedo / Afternic / Squadhelp listing check (price floor signal)

**These five checks take ~5 minutes. They should gate any rename
recommendation.** The web-search rounds (1–6 of this doc) were
useful for surfacing competing AI products in the same category, but
they cannot see corporate defensive holdings — those are invisible to
search engines because they have no public-facing site.

### 8.13 Recalibrated front-runner list (post-whois)

Survivors of all six search rounds + the round-7 whois lesson, with
honest caveat that **none of these have been whois-verified yet**:

1. **Plinth** — needs `whois plinth.{com,ai,dev,app,io,so}` before any
   recommendation. Suspicion: lower brand-protection profile than
   Lockstep (Plinth isn't an absorbed company-brand), so corporate
   defensive holdings less likely — but verify before recommending.
2. **Forgewright** — coined, very low corporate-defensive risk; almost
   certainly all TLDs are open.
3. **Throughline** — known multi-use word; some defensive holdings
   possible. Whois first.
4. **Bowline** — known nautical term + Bowline (a few small
   companies); whois first.
5. **Buttress** — common English word; almost certainly some corporate
   defensive holdings exist (architectural / construction). Whois first.
6. **Bridlepoint** — coined-compound, low risk; whois first.

**Next concrete step before another recommendation:** run the same
five-check whois battery on the top 3 (Plinth, Forgewright, Throughline)
and see which one has the cleanest corporate footprint, not just the
cleanest search results.

### 8.14 Round-8 — whois battery on the post-Lockstep shortlist

All three rare-English-word fallbacks are compromised:

| Name | .com | .ai | GitHub |
|---|---|---|---|
| **Plinth** | TAKEN since 1999 (NameCheap-locked corporate) | TAKEN April 20, 2026 — **9 days ago** under WhoisGuard privacy | TAKEN ("Plinth" org) |
| **Forgewright** | TAKEN April 2025 (newly registered, private holder) | TAKEN August 2025 (newly registered, private holder) | TAKEN |
| **Throughline** | TAKEN since 2005 (Cloudflare-locked) | TAKEN under Domains By Proxy with all four `client*Prohibited` locks — corporate defensive pattern | TAKEN |

**Plinth.ai registered 9 days before this research session** — someone
is actively bulk-buying these. The English-rare-word strategy is dead.

### 8.15 Round-9 — coined-word stress test

Tested 14 short coined words (vorex, stratix, praxen, veron, solyn,
vellix, trovix, korix, aerys, tactus, pellis, varnix, cohera, ardex):
**every single one was TAKEN on .com AND .ai AND GitHub.** Cohera.com
since 1998. Solyn.com since 2004 (paid through 2035).

Verdict: **Vercel-style 5-7 letter coined words are exhausted.**
Domain investors bulk-bought every plausible-sounding pronounceable
invented word a decade ago and held them through the AI boom.

### 8.16 Round-10 — phonotactically familiar invented words

Tested longer / less-Latin / surname-or-placename-feel coined words.
Of 32 candidates, **3 fully open + phonetically obvious**:

| Name | Read | Status |
|---|---|---|
| **Spinewright** | SPINE-rite | ✅ all OPEN; SPINE + WRIGHT (real-word compound) |
| **Brakwell** | BRAK-well | ✅ all OPEN; surname/placename pattern (cf. Hartwell, Bracknell) |
| **Rookstrand** | ROOK-strand | ✅ all OPEN; ROOK + STRAND (real-word compound) |

User feedback on the all-coined batch (Yvarn, Pylvan, etc.):
**"No one will know how to pronounce it."** Correct critique — Y-as-vowel
ambiguity and unfamiliar consonant clusters create the Pulumi-tax.
Real-word compounds avoid this entirely.

Strong "almost there" candidates with only `.com` taken:
- **Bridgehold** — fortress/control, both real words; .ai + GitHub OPEN
- **Northkeep** — fortress feel; .ai + GitHub OPEN
- **Forgeward** — "forge forward" reading; .ai + GitHub OPEN

### 8.17 Round-11 — VARNI (user-found candidate)

User reported `varni.ai` as available. **Confirmed and verified the
full footprint:**

| | Status |
|---|---|
| `varni.ai` | ✅ **OPEN** (whois: "Domain not found") |
| `varni.io`, `.dev`, `.app`, `.so` | ✅ All OPEN |
| `varni.com` | ❌ TAKEN since 1999 (GoDaddy, all four `client*Prohibited` locks — long-held private holder) |
| `github.com/varni` | ❌ TAKEN (likely an Indian developer — Varni is a common Indian girl's name) |
| `github.com/varni-ai`, `/varnihq`, `/varni-labs` | ✅ All OPEN — org-name alternatives work |

**Brand conflicts in our category:** None at scale. Multiple small
Indian IT-services consultancies (Varni Technology, Varnitech, Varni
Tech, Varni Labs, Varni IT Solutions, Varni Infotech) — **none in
AI / dev tools / agent orchestration**. Will pollute Indian-market
search results; will not block a global AI brand.

**Sound + brandability:**

| Test | Verdict |
|---|---|
| Pronounceable on first read | ✅ "VAR-nee" — same vowel pattern as Vermont, Bernie, varnish |
| Sound profile (Vercel / Cohere / Plaid school) | ✅ Two syllables, soft-modern AI brand feel |
| Enterprise read | ✅ Serious without stuffy |
| Distinctiveness in AI | ✅ Owns its category search results from launch |
| Sanskrit origin meaning | ✅ Positive: "pure / guardian / colors / one who describes or praises" |
| Notable historical figure | Varni Srinivasa Iyengar (Indian jurist, freedom fighter, 1891–1969) — neutral-positive association |

**Honest caveats:**

1. **`varni.com` is unbuyable.** 1999-registered + all four Prohibited
   locks = serious holder, not a flipper. **Plan: launch on `varni.ai`,
   never own `.com`.** Many AI-tier brands operate this way
   (`mistral.ai` is the canonical Mistral brand).
2. **GitHub org via `varni-ai` or `varnihq`.** Hyphen tax acceptable
   (`anthropic-ai`, `openai-archive` set the precedent).
3. **Slightly feminine sound** because it's an Indian girl's name. In
   2026 mostly a positive — Anthropic, Cohere, Mistral are all
   soft-coded successful AI brands.

### 8.18 Honest top picks after eleven rounds

After the full search-and-whois battery, the candidates that
actually clear every gate:

1. **Varni** ⭐⭐ — `varni.ai` open; pronounceable; no AI conflict;
   brandable; positive Sanskrit meaning; **first candidate to hit
   every test simultaneously**. Caveat: never own `.com`. Recommend.
2. **Spinewright** — fully open across .com/.ai/GitHub; both real
   English words; pronounceable; structural metaphor.
3. **Bridgehold** — fortress/control feel; pronounceable; .com taken
   but .ai + GitHub open; would need .com negotiation.
4. **Brakwell** — fully open; placename-feel; pronounceable.
5. **Rookstrand** — fully open; real-word compound.

**Varni is the recommendation.** It's the first name across eleven
rounds of search + whois that combines (a) `.ai` actually open, (b)
pronounceable on first read, (c) no AI/dev-tools competitor, (d)
brand-feel matching the Vercel/Cohere/Plaid/Mistral school. The
trade-off — never owning `varni.com` — is a real cost but a
well-trodden one for AI-era brands.

### 8.18d Round-12 — VARNI WALKBACK (consumer electronics conflict)

**User-flagged after round 11:** *"Oh no it's an Indian electronics brand."*

**Confirmed.** VARNI is a real Indian premium consumer electronics
brand, active since 2009 (Varni Digital since 2014):

- **Mobile accessories:** Bluetooth speakers, headsets, headphones,
  power banks, USB cables, mobile cases, touch screens, LCDs
- **Home automation:** touch switch modules, sensors, remote control
  switches
- **20,000 dealers and distributors across India**
- Active retail: **Amazon.in, Flipkart, Snapdeal** with multiple
  product lines (SP06, S7, S205, B92, SP25, etc.)
- Active socials: `@varniindia` Instagram, `@varnigujarat` Facebook,
  LinkedIn corporate presence
- Tagline: *"A Proudly Indian Brand"*

**Why this is fatal — the Class 9 trademark problem.**

Both consumer electronics AND computer software live in trademark
**Class 9**. VARNI almost certainly holds Class 9 marks in India for
their electronics. Class 9 also covers:
- Bluetooth speakers (their product) ✅
- Computer software (our product) ✅
- Mobile applications ✅
- Cloud services ✅

If VARNI has filed Madrid Protocol international registrations —
common for brands at this distribution scale — the mark has force in
US/EU. Even without international filings, the Indian market is
closed to "Varni" as a software brand, and Indian electronics brand
could oppose any USPTO filing on prior-use grounds.

**Methodology lesson harder than round 7's:** even a clear `.ai`
domain can be blocked by an offline trademark holder in the same
Class. My round-11 searches for "Varni AI / dev tools / software"
missed "Varni speakers / electronics" entirely because I never
queried product categories outside our own.

**Verdict: Varni is dead.** Class 9 collision + 17-year-old brand +
20,000 distributors + retail presence on three major Indian
e-commerce platforms = unrecoverable.

**Update to §8.12 methodology checklist** — add:
- 6. Search the candidate name + adjacent trademark-Class product
     categories (electronics, hardware, devices) — not just AI / dev
     tools. A Class-9 trademark holder in *any* Class-9 product
     category can block your software/SaaS use.

### 8.18e Final rest state — duraclaw vs. fallbacks

User narrowed the decision to **Varni vs. duraclaw**. Varni is now
killed. That collapses the active rebrand option as framed.

Remaining options:

1. **Stay with duraclaw.** The eleven-round search exhausted realistic
   high-quality candidates. The friction tax of duraclaw's name is
   real but bounded; the cost-of-rebrand-to-mid-tier-name may exceed
   it. Datadog precedent: playful brand + great product = fine.

2. **Spinewright** — only fully-open + pronounceable + real-word
   compound left standing. Lower brand-credibility ceiling than
   Varni would have had. Zero trademark / domain risk.

3. **Bridgehold** — best sound profile of remaining candidates;
   `.ai` + GitHub OPEN; only `.com` in the way. Negotiation play if
   the .com holder is a flipper.

**Final recommendation:** stay with duraclaw. After 12 rounds, the
universe of available enterprise-credible AI brand names is
effectively exhausted. The next-best names (Spinewright, Bridgehold)
are real options but neither is *clearly* better than duraclaw in a
way that justifies a 2-4 week migration + SEO loss + break-something
risk + team context-switch. Spend the rebrand-budget engineering
time shipping product. Revisit only if duraclaw the name actually
loses a deal in the next quarter.

### 8.18b Brand-prior concern (Indian recognition) — and revision

**Concern raised:** *"Too Indian sounding?"*

**Initial answer:** real concern — "Varni Technology / Varni Tech /
Varni Labs / Varnitech / Varni IT Solutions / Varni Infotech" pattern-
match against the IT-services-consultancy prior in US/EU enterprise
procurement.

**User counter:** *"Most people have never heard of Varni or know it's
an Indian name."*

**Revised assessment — user is right.** Varni is *not* in the recognized
tier of Indian names that Western audiences identify (Raj, Priya,
Ananya, Arjun). To most US/EU engineers and procurement officers,
"Varni AI" reads as a generic two-syllable AI brand in the shape of
Mistral / Cohere / Vercel — the ethnic-recognition fires only for
people who already know Sanskrit roots. Blast radius is much smaller
than the initial response implied.

The Indian-IT-services-search-pollution concern remains, but a
well-funded global brand at `varni.ai` would dominate search results
within 6-12 months given the small companies' low SEO authority.

**Revised verdict on Varni:** technically and brand-credibly viable.
Decision now reduces to **Varni vs. duraclaw** — i.e., rebrand or not.

### 8.18c Final decision frame — Varni vs. duraclaw

| Axis | Varni | duraclaw |
|---|---|---|
| Sounds enterprise-credible | ✅ Mistral/Cohere/Vercel-tier | ❌ Indie hacker tool |
| README positioning fit | ✅ Matches "harness for enterprise AI" | ❌ Playful brand vs. enterprise pitch |
| Domain economics | ✅ `varni.ai` open | ✅ `duraclaw.com` already owned |
| Search-result ownership | Will dominate in 6-12 months | Already dominates |
| Procurement-deck test | Passes | Friction (original problem) |
| Migration cost | ❌ ~2-4 weeks: 9 npm packages, wrangler scripts, R2/D1 names, Capacitor app ID `ai.baseplane.duraclaw`, install scripts, all docs, GitHub org, hero image, OTA paths | ✅ Zero |
| SEO continuity | ❌ Lose equity, 6-12 month recovery | ✅ Preserved |
| Risk of breaking things | Real | Zero |

**Critical question:** *Has the duraclaw name actually cost a deal, or
is the friction anticipated?* If actual: rebrand now. If anticipated:
migration cost may exceed friction cost.

**Recommendation given visible signals (active development, pre-broad-
launch, README explicitly repositioned for enterprise last week):**
**Rebrand to Varni.** The README's enterprise framing requires an
enterprise-credible name to land; keeping duraclaw asks the README to
do work the name should do. Migration cost is finite; brand friction
is unbounded and compounds with every enterprise conversation. The
window to rebrand cheaply closes the moment meaningful enterprise
customers land.

**Caveat:** if team bandwidth is over-committed to feature roadmap
or current customer base already accepts the name, "ship features,
defer rename" is a defensible call.

### 8.19 Pre-public-mention action list (Varni)

Lock down before mentioning the name in any public channel — once
"Varni AI" surfaces in search results, the `.com` holder Googles you
and pricing on every other asset triples:

1. **Register today (cheap, all open):**
   - `varni.ai` (the launch home)
   - `varni.io`, `varni.dev`, `varni.app`, `varni.so` (defensive)
2. **Claim GitHub org** — `varni-ai` (preferred, matches `anthropic-ai`
   pattern) or `varnihq`
3. **Reserve npm scope** — `@varni`
4. **Reserve social handles** — `@varni_ai` on X / Bluesky / LinkedIn
5. **THEN start trademark work** — USPTO TESS classes 9 + 42; small
   Indian IT shops likely don't have US software marks but verify.
   EUIPO eSearch in parallel.
6. **Locale check** — Varni is positively-coded in Sanskrit / Hindi
   contexts; verify no negative meanings in Mandarin / Japanese /
   Spanish / French / German / Korean / Arabic.
7. **Only after #1–#6 clear:** announce the rename internally, write
   the rename spec, and begin the migration plan.

### 8.8 Honest top picks after five rounds

In rough order, the candidates that have survived every round of
conflict checking AND read as enterprise-credible:

1. **Lockstep** ⭐ — *new front-runner after round 5.* Hits every test:
   sound (single phonetic unit, hard consonants), verb-energy
   (matches user's Strider/Cascade gut), enterprise read
   (disciplined / governed), conflict-clear in AI / dev-tools, and
   parent-brand-coherent. The README's positioning sentence writes
   itself: *"every agent, every tool call, every gate moving in
   lockstep with your policy."*
2. **Plinth** — strongest brand-family pair with `baseplane`, owns its
   search results, but quieter than Lockstep on verb-energy
3. **Throughline** — clear and motion-coded, but three syllables
4. **Forgewright** — fully coined, brandable, no conflicts
5. **Bowline** — nautical, short, no conflicts
6. **Buttress** — industrial register, known word but rare in tech
7. **Bridlepoint** — riffs on README's "harness" without Harness.io
   collision

**Tempest** is on probation — survivable if the team accepts being
"Tempest" while Tempest AI (game dev) is "Tempest AI". Different
category, but the .ai handle costs you.

**The honest answer after five rounds:** the AI dev-tools naming
namespace is densely occupied for short English words, but **Lockstep
is the front-runner** — it's the only candidate that combines
brandability, verb-energy, enterprise-credibility, and conflict
clearance. The Sage acquisition of accounting-Lockstep (closed 2024)
actually clears the standalone software namespace. Pending the
trademark / domain / npm checks, Lockstep is the recommendation.

---

## Sources (round 5)

- [Sage Group acquires Lockstep (Aug 2022 announcement)](https://www.businesswire.com/news/home/20220815005687/en/The-Sage-Group-Signs-Deal-to-Acquire-Connected-Accounting-Leader-Lockstep)
- [Sage acquires Lockstep | Accounting Today](https://www.accountingtoday.com/news/sage-acquires-accounting-software-provider-lockstep)
- [Lockstep-Network/lockstep-sdk-python (Sage org, accounting context)](https://github.com/Lockstep-Network/lockstep-sdk-python)
- [wonderkiln/lockstep.io (Unity networking lib, hobby)](https://github.com/wonderkiln/lockstep.io)
- [Lockstep PitchBook profile](https://pitchbook.com/profiles/company/327093-85)

## Sources (round 4)

- [Windsurf Cascade — Windsurf's flagship agent](https://windsurf.com/cascade)
- [Windsurf docs — Cascade](https://docs.windsurf.com/windsurf/cascade/cascade)
- [Windsurf review 2026 — #1 in LogRocket AI Dev Tool Power Rankings](https://www.taskade.com/blog/windsurf-review)
- [stride.build — Agentic AI Solutions for Enterprise](https://www.stride.build/agentic-ai)
- [STRIDE threat-modeling framework](https://aviatrix.ai/threat-research-center/ai-threat-modeling-frameworks-2026/)
- [Harbinger AI](https://www.harbinger.ai/)

## Sources (round 3)

- [Strider Technologies — Strider OS launch](https://www.prnewswire.com/news-releases/strider-launches-agentic-operating-system-to-power-next-generation-of-strategic-intelligence-302750846.html)
- [striderintel.com](https://www.striderintel.com/)
- [strake.dev — SRE Intelligence Platform](https://strake.dev/)
- [Strake Inc. (OTC: SRKE) AI pivot](https://www.tennesseedaily.com/news/274015566/strake-inc-otc-srke-marks-new-beginnings-with-ticker-symbol-transition-and-bold-leap-into-ai)
- [Straiker.ai — agentic-first AI security ($21M)](https://www.straiker.ai/blog/straiker-launches-with-21-million-to-safeguard-ai)
- [Spire.AI Knowra — talent platform](https://spire.ai/)
- [Spire.AI on G2 ($68.8M raised)](https://www.g2.com/products/spire-ai/reviews)
- [Wolters Kluwer Praetor AI](https://www.wolterskluwer.com/en/solutions/praetor/praetor-ai)
- [Praetorian — offensive security](https://www.praetorian.com/)
- [Tempest AI — game creation (Sydney)](https://pitchbook.com/profiles/company/756073-81)

## Sources (round 2)

- [Halcyon.ai — anti-ransomware platform](https://www.halcyon.ai/)
- [Anthropic Claude Code KAIROS leak (Mar 31 2026)](https://www.streetinsider.com/Press+Releases/Claude+Code+Leak+Reveals+KAIROS:+Anthropic%E2%80%99s+Unreleased+Persistent+AI+Agent+Raises+Questions+About+the+Future+of+AI+Memory/26281658.html)
- [Agent-Kairos | Medium (Apr 2026)](https://medium.com/data-and-beyond/agent-kairos-8c42538c240a)
- [Onyx — open-source AI platform](https://onyx.app/)
- [Cobalt AI launches data infrastructure](https://www.businesswire.com/news/home/20260217348798/en/Cobalt-AI-Launches-Advanced-Data-Infrastructure-for-AI-Labs)
- [Atos Polaris AI Platform on AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-5hs53x6h5xtyq)
- [Crux (YC W24) | TechCrunch](https://techcrunch.com/2024/02/08/crux-is-building-genai-powered-business-intelligence-tools/)
- [IBM Granite — open AI models for code](https://www.ibm.com/granite)
- [Telos 2.0 — AI Agent for Unreal Blueprints | Games Press](https://www.gamespress.com/en-US/Next-Evolution-of-Best-In-Class-Multi-agent-AI-Assistant-for-Unreal-En)
- [Vega Minds — AI agents](https://help.vegaminds.com/en/articles/10050475-vega-s-ai-agents)
- [Lodestar (closed) | Crunchbase](https://www.crunchbase.com/organization/lodestar-ae84)
