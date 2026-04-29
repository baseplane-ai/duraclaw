# UI Primitives

This sublayer holds duraclaw's UI primitives — visual structure and interaction patterns described as wireframe-level behavior contracts, independent of any particular component library.

## Layer test

A UI primitive **survives a stack rewrite** but NOT a UI redesign. If the underlying component library changes (Tailwind to Tamagui, Radix to a fresh wrapper, React 19 to whatever's next) the primitive's contract is still load-bearing — only its implementation moves. If the *visual or interaction model* changes (a different chain-status glyph, a redesigned message layout, a new presence affordance) the primitive's doc has to change with it.

## The disambiguation rule

**UI = visual structure or interaction pattern; Arch = abstract building block independent of UI.** If a primitive describes how something *looks* on screen or how the user *interacts* with it, it's UI. If it describes a mechanism that exists below the UI layer (a ring buffer, a dial-back protocol, a session lifecycle), it's Arch.

## Design-tokens primitive

The canonical design-system rules for duraclaw live outside `docs/`, at `.interface-design/system.md` (a directory of design-system rules maintained alongside the repo). That file is duraclaw's design-tokens primitive — direction, depth, spacing scale, radius, typography, callout patterns, drift-watch list. It is surfaced as a primitive here via `design-system.md`, which lifts the contract-level content and adds a "Where this lives in code" pointer back to the source.

## Index of UI primitives

- [`design-system.md`](./design-system.md) — tokens, tone, layout primitives. The visual voice (neutral utility, dense-when-needed, calm) and the rules that keep it consistent.
- [`ai-elements.md`](./ai-elements.md) — the catalog of agent-conversation UI primitives (Message, Tool, Reasoning, Conversation, ChainOfThought, …) by behavior contract.
- [`chain-status.md`](./chain-status.md) — the rung-ladder primitive for surfacing kata-chain progress: states, transitions, stall signals.
- [`tabs-and-drafts.md`](./tabs-and-drafts.md) — the collaborative draft + tab primitive: presence, live cursors, CRDT merge contract.
