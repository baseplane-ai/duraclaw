---
date: 2026-04-27
issue: 27
type: spike-result
status: GREEN
spec: planning/specs/27-docs-as-yjs-dialback-runners.md
spike_branch: spike/gh27-blocknote-bun (throwaway, not merged)
---

# GH#27 P0 Spike Result — BlockNote + Bun + jsdom feasibility

## Verdict: GREEN

The full markdown ↔ Y.XmlFragment round-trip mandated by the spec's
`pre_phase_gate` works under Bun on first attempt. **No fallback (remark
+ manual `Y.XmlElement`) is required.** P3a's `blocknote-bridge.ts`
proceeds with BlockNote as primary plan; P3a budget does not need the
+3–4 day fallback buffer.

## Pinned versions (proven clean under Bun 1.3.13)

| Dep                       | Version |
| ------------------------- | ------- |
| `@blocknote/core`         | 0.49.0  |
| `@blocknote/server-util`  | 0.49.0  |
| `jsdom`                   | 26.1.0  |
| `yjs`                     | 13.6.30 |
| `gray-matter`             | 4.0.3   |

Spec hint pinned `~v0.48.x`; latest stable is `0.49.0` and worked first
try. P3a should pin `^0.49.0` for `@blocknote/core` and
`@blocknote/server-util`.

## Coverage

All B17 GFM blocks survive semantically:

- Frontmatter (gray-matter strip + restore, deep-equal on re-parse)
- Heading levels h1–h3
- Paragraph with **bold**, *italic*, `inline code`, [link](…)
- Unordered list with nested item
- Ordered list
- Blockquote with embedded **bold**
- Fenced code block (language tag preserved)
- 2×2 GFM table with header row

Reduced semantic-token stream is line-for-line identical between
original and round-trip; differences are cosmetic-only:

1. `tags: [a, b]` → `tags:\n  - a\n  - b` (gray-matter default block style)
2. `-` bullet marker → `*` (BlockNote default; CommonMark-equivalent)
3. List rendered "loose" (blank line between items) — stable on second pass

## Bun-compat hard data

- `bun install`: 244 packages, 5.57s, **zero postinstall errors, zero
  native-binding warnings**.
- `gray-matter` is CJS but Bun's import-interop handles default-import
  cleanly (`import matter from 'gray-matter'`).
- `jsdom@26` imports without `canvas` peer.
- `@blocknote/server-util` ships dual ESM+CJS; Bun picks ESM.
- Round-trip script runs <2s wall.

## Bridge API (proven)

```ts
import './jsdom-bootstrap'        // MUST be first import everywhere
import { ServerBlockNoteEditor } from '@blocknote/server-util'
import * as Y from 'yjs'

const editor = ServerBlockNoteEditor.create()

// md → Y.Doc
const blocks  = await editor.tryParseMarkdownToBlocks(body)
const ydoc    = new Y.Doc()
editor.blocksToYXmlFragment(blocks, ydoc.getXmlFragment('document-store'))

// Y.Doc → md
const blocks2 = editor.yXmlFragmentToBlocks(ydoc.getXmlFragment('document-store'))
const md      = await editor.blocksToMarkdownLossy(blocks2)
```

The `'document-store'` fragment name is a project-wide constant —
runner, DO, and browser editor must all agree on it. (Spec already
states this; reaffirm in B7 implementation notes.)

The `jsdom-bootstrap.ts` shim setting `globalThis.window` / `document`
plus a range of `HTMLElement` constructors **before** any
`@blocknote/*` import is sufficient. `ServerBlockNoteEditor`
additionally uses `_withJSDOM` per call as belt-and-braces.

## Implementation notes for P3a (B7/B8 amendments — not blockers)

These do not change task scope; they are heads-up notes the runner
implementer should be aware of so they don't ship a write-loop bug.

### N1 — Content-hash gate must hash the normalised form

**Concern:** B7 specifies the file→Y.Doc steady-state path. B8 specifies
"compute `sha256(file)`; compare against `.duraclaw-docs/hashes.json`".
Round-tripped files diverge cosmetically from their on-disk originals
(bullet marker, list looseness, YAML flow style). If the runner stores
`sha256(originalDiskBytes)` and on the next chokidar event compares
against `sha256(currentDiskBytes)`, a write-back from a remote edit
will produce *new* normalised bytes on disk, the next change event will
see hash-changed, and the runner will push that "change" back to the
DO — not strictly an infinite loop (DO is idempotent on identical
content) but unnecessary churn and a reconciliation noise source.

**Resolution:** Either (a) hash the *normalised* round-tripped form
(`sha256(blocksToMarkdownLossy(parsed))`) so disk and DO compare
apples-to-apples, or (b) keep the current spec wording but rely on B9's
`suppressedPaths` window (2000ms) to swallow the immediate echo and
accept the no-op DO push. Option (a) is cleaner; recommend B7/B8 add
language clarifying that hash comparisons are over the normalised form.

### N2 — Frontmatter formatting preservation (optional polish)

gray-matter's default emit converts YAML flow style (`tags: [a, b]`)
to block style. Users who care about frontmatter formatting will see
their files reformatted on first DO write-back. Cheap mitigation: the
runner's `writer.ts` preserves the *original* frontmatter byte-slice
when the parsed object is unchanged, only re-stringifying when keys
or values actually differ. Add to P3a writer task; ~10 LoC.

### N3 — Reaffirm `'document-store'` fragment name as a shared constant

Add to `packages/shared-types/` as an exported constant
(`DOCS_YDOC_FRAGMENT_NAME = 'document-store'`) so the runner, the DO
(if it ever needs to introspect the fragment), and the browser editor
import the same string. Spec already names it; this is just preventing
the typo class of bug.

## Spike artifacts

- Code: `spike-gh27-blocknote-bun/` on branch `spike/gh27-blocknote-bun`
  (throwaway, not merged, not pushed). Discard the branch when this
  research doc has landed on `feature/27-docs-runner`.
- The spike code is reference-only — `packages/docs-runner/` will be
  built fresh in P3a per the spec, not copied from the spike.

## Decision

**Proceed with task #2 (P1.1 D1 schema) and downstream chain as auto-
generated.** Task #4 (P1.3 docs-runner scaffold) does not need
description amendment for the spike outcome itself, but the runner
implementer should consult notes N1–N3 above when writing
`blocknote-bridge.ts`, `content-hash.ts`, and `writer.ts`. Linking this
research doc from B7/B8/B11 source lines in the spec is sufficient.
