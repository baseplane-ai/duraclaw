# Duraclaw — Interface Design System

Extracted 2026-04-16 from `apps/orchestrator/src` (shadcn/ui on Tailwind v4).

## Direction

Neutral utility — a control panel for orchestrating long-running agent sessions. Quiet structural chrome that gets out of the way of dense, fast-changing session content (chat threads, status pills, live state). Information first, decoration never.

**Feel:** technical, dense-when-needed, calm. Status communicates through color; everything else is grayscale.

## Token Source

All colors come from `apps/orchestrator/src/styles/theme.css`. OKLCH primitives, dual light/dark, mapped via `@theme inline` to Tailwind utilities.

Semantic tokens: `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`, `chart-1..5`, `sidebar-*`.

**Rule:** never reach for raw Tailwind palette utilities (`bg-blue-500`, `text-gray-400`, etc.) for structural surfaces, text, or borders. Use the semantic tokens. The only allowed exception is intentional status color encoding (see Status Colors below).

## Depth

**Hybrid, leaning borders.** Borders carry the structural load. Shadows are reserved for two roles: whisper-quiet lifts on inline interactive controls, and clear separation for portaled floating layers.

| Surface | Treatment |
|---------|-----------|
| Page / sidebar / sections | `border` only — no shadow |
| Cards (in-flow) | `border` + `shadow-sm` |
| Inline controls (button, input) | `shadow-xs` |
| Popovers, dropdowns, tooltips | `border` + `shadow-md` |
| Dialogs, sheets, toasts (floating) | `border` + `shadow-lg` |
| Selection emphasis (rare) | `shadow-2xl` only on `data-state=checked` swatches |

Sidebar shares background with canvas — separation is a `border` only, not a different surface color.

Anything off this table is drift.

## Spacing

**Base unit: 4px** (Tailwind default).

Scale in use: `1 (4) · 1.5 (6) · 2 (8) · 3 (12) · 4 (16) · 6 (24) · 8 (32)`.

- Micro (icon gaps, pill padding): `gap-1.5`, `gap-2`
- Component internals (button padding, input padding): `px-3 py-1`, `px-4 py-2`
- Card internals: `p-6` (header/content/footer all use `px-6`, root uses `py-6`, `gap-6` between sections)
- Section / list gaps: `gap-2` to `gap-4`

If you need a value off this scale, the answer is almost always one of the scale values — pick one.

## Radius

Driven by `--radius: 0.625rem` (10px) with derived steps:

- `radius-sm` = 6px → small chips, secondary controls
- `radius-md` = 8px → buttons, inputs, default
- `radius-lg` = 10px → standalone interactive surfaces
- `radius-xl` = 14px → cards, dialogs

Pills (`rounded-full`) are reserved for status badges and tag-like affordances (see ActiveStrip).

## Typography

Fonts: `Inter` (UI), `Manrope` (display, opt-in).

Hierarchy:
- Title / heading: `font-semibold`, `leading-none`
- Body: default weight, `text-sm` in dense surfaces, `text-base` on inputs (jumps to 16px on mobile to prevent zoom — see `styles.css:52`)
- Supporting: `text-sm text-muted-foreground`
- Metadata / labels: `text-xs font-medium`

## Component Patterns

### Button (`components/ui/button.tsx`)

| Size | Height | Padding | Radius |
|------|--------|---------|--------|
| `sm` | h-8 (32px) | `px-3` | `rounded-md` |
| `default` | h-9 (36px) | `px-4 py-2` | `rounded-md` |
| `lg` | h-10 (40px) | `px-6` | `rounded-md` |
| `icon` | size-9 | — | `rounded-md` |

- Variants: `default`, `destructive`, `outline`, `secondary`, `ghost`, `link`
- All non-link variants carry `shadow-xs`
- Focus: `focus-visible:ring-ring/50 ring-[3px]` + `border-ring`
- Icons inside autoshrink to `size-4`; padding tightens with `has-[>svg]`

### Card (`components/ui/card.tsx`)

- `rounded-xl`, `border`, `bg-card`, `shadow-sm`
- Vertical rhythm: `py-6` root, `gap-6` between subparts
- Horizontal padding: `px-6` on header / content / footer
- `CardHeader` is a 2-row CSS grid; `CardAction` opt-in adds a right-aligned action column

### Input (`components/ui/input.tsx`)

- `h-9`, `rounded-md`, `border border-input`, `bg-transparent` (light) / `bg-input/30` (dark)
- `px-3 py-1`, `shadow-xs`
- Focus: `border-ring` + `ring-ring/50 ring-[3px]`
- Invalid: `aria-invalid` → `border-destructive` + `ring-destructive/20`
- Mobile: forced `font-size: 16px` to prevent iOS focus zoom

### Status Colors (allowed escape from tokens)

Used **only** for live session status encoding (e.g. `ActiveStrip.tsx`):

| Status | Color |
|--------|-------|
| `running` & 0 turns (spawning) | `bg-blue-500` |
| `running` | `bg-green-500` |
| `waiting_*` | `bg-yellow-500` |
| `idle` (recent) | `bg-gray-400` |

Anywhere else, raw palette colors are drift — flag them.

## System Gaps

The current token set has **no `info`, `warning`, or `success` semantics** — only `destructive`. Several components reach for raw palette tints (`bg-blue-500/5`, `bg-yellow-500/5`, `bg-amber-950/50`) to fill that gap. Two ways out:

- Add `info` / `warning` / `success` semantic tokens (foreground + background pair, light + dark) to `theme.css`.
- Or formally bless the raw-palette pattern with documented opacities (e.g. always `/5` background + `/30` border) so it's a system, not drift.

Until one of those happens, "info/warning callouts" are an open question whenever they appear.

## Drift to Watch

1. **Raw palette colors** outside the status-encoding contract or the (currently unblessed) info/warning callout pattern.
2. **Off-scale spacing.** Anything not on the `4 · 6 · 8 · 12 · 16 · 24 · 32` scale is suspect.
3. **Shadows that don't match the depth table** (e.g. `shadow-md` on a card, `shadow-lg` on a section).
4. **Bespoke radii** — `rounded-[28px]` and similar one-offs should justify themselves or move onto the `sm/md/lg/xl` scale.
5. **Inline hex / arbitrary `bg-[#…]`.** Always a token miss.

## Conventions

- Tailwind v4, class-variance-authority for variants, Radix primitives wrapped in `components/ui/*`
- `cn()` utility from `~/lib/utils` for class merging
- Path alias `~/` → `apps/orchestrator/src/`
- Biome formatting: 2-space indent, 100 char width, single quotes, no semicolons
