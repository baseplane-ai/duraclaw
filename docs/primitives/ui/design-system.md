# Design System

> Duraclaw's tokens, tone, and layout primitives — the visual voice that makes the orchestrator look like one app.

## Layer test

This primitive survives a stack rewrite but NOT a UI redesign. The token names will change if the styling library changes; the *contract* (a small set of semantic surfaces, a discrete spacing scale, a borders-first depth model, a calm neutral palette) is what every screen has to honour.

## Concept

The design system is the contract that keeps a control panel for long-running agent sessions visually quiet. **Information first, decoration never.** Status communicates through color; everything else is grayscale. Borders carry the structural load. Shadows whisper.

It is currently backed by Tailwind v4 and Radix-wrapped components, but the contract is stack-independent: a future port to a different styling system has to preserve the semantic-token discipline, the depth model, the spacing scale, and the callout pattern, regardless of how those concepts are spelled.

## Tone

- **Neutral utility.** A control panel, not a marketing surface. Quiet structural chrome that gets out of the way of dense, fast-changing session content.
- **Technical, dense-when-needed, calm.** Status pills, live state, chat threads — these win the visual weight. Frames around them stay near-invisible.
- **Dark-mode-first OKLCH palette** with a paired light mode. Both modes share the same semantic-token names; the OKLCH primitives flip per mode.
- **Conservative color use.** Raw palette colors (a literal blue or amber) are reserved for the live-status encoding. Everywhere else, color goes through a semantic token.

## Tokens

The semantic tokens — not the underlying primitives — are the contract. Roughly:

- **Surfaces:** background, card, popover, sidebar.
- **Text:** foreground, muted-foreground, plus paired *-foreground tokens for text on solid status surfaces.
- **Lines:** border, input, ring (focus).
- **Status family:** destructive, info, warning, success — each with a `-foreground` partner for solid fills.
- **Brand:** primary, secondary, accent.
- **Chart slots:** a small numbered set, used for data visualisations only.

Rule: never reach for raw palette utilities for structural surfaces, text, or borders. The only blessed exception is the live-status encoding (running / spawning / waiting / idle), which is allowed to encode meaning through specific palette colors because the encoding is the contract.

## Layout primitives

- **Spacing:** a 4px base unit, with the discrete scale `4 · 6 · 8 · 12 · 16 · 24 · 32`. Anything off-scale is drift.
- **Radius:** `sm 6 / md 8 / lg 10 / xl 14`, derived from a single `--radius` knob. Pills (fully rounded) are reserved for status badges and tag-like affordances.
- **Depth (borders-first):** page and sidebar wear a border only; cards add a whisper-quiet card shadow; popovers and dropdowns lift a notch; dialogs and sheets lift further. Floating layers always carry a border in addition to a shadow. Anything off this table is drift.
- **Stacks:** vertical rhythm between card subparts and section gaps lives on the same spacing scale; the same scale governs micro-gaps inside pills and component internals.
- **Typography:** an interface family for UI and a display family for opt-in headlines. Hierarchy is body (default), supporting (smaller + muted), and metadata (smaller + medium-weight).

## Callout pattern

Semantic status surfaces share a fixed opacity recipe so every callout looks like a family member, regardless of which status it carries:

- **Subtle, transient callout** (an inline Q&A rail, a gate-resolver panel) — low-opacity tinted background, low-opacity tinted border, full-strength tinted label text.
- **Persistent ambient bar** (an always-on running / waiting strip) — mid-opacity tinted background, mid-opacity tinted border.
- **Solid blocking banner** (offline, fatal error) — solid tinted background, paired `-foreground` text token.

Any tinted surface that doesn't fit one of these three recipes is drift.

## Drift to watch

Things that almost always indicate the contract is being broken:

1. Raw palette colors outside the live-status encoding.
2. Off-scale spacing values.
3. Shadows that don't match the depth table (a card-weight shadow on a section, a dialog-weight shadow on a card).
4. Bespoke radii (one-off values) that don't justify themselves against the scale.
5. Inline hex / arbitrary color values — always a token miss.

## Where this lives in code

- `.interface-design/system.md` — canonical design-system rules file (the source this primitive is lifted from).
- `apps/orchestrator/src/styles/theme.css` — OKLCH primitives and `@theme inline` mapping that wires tokens to the styling system.
- `apps/orchestrator/src/components/ui/` — primitive component implementations (button, card, input, …) that bake the token contract in.
