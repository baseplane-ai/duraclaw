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
