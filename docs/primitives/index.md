# Primitives

Primitives are duraclaw's stack-independent building blocks. A primitive survives a stack rewrite but NOT a UI redesign — its behavior contract is what the rest of the system depends on, regardless of which library or framework currently implements it.

## Layer test

Primitives **survive a stack rewrite** but NOT a UI redesign. If a doc would also survive a UI redesign, it's Theory. If it wouldn't survive a stack rewrite, it's a Module.

## Sublayers

- `ui/` — visual structure or interaction pattern. Wireframe-level descriptions, behavior contracts, state diagrams. No React imports, no component file paths.
- `arch/` — abstract building block independent of UI. Things like ring buffers, dial-back patterns, sync protocols. A different transport library would still need this primitive.

The disambiguation rule: **UI = visual structure or interaction pattern; Arch = abstract building block independent of UI.** If a primitive describes how something *looks* or how the user *interacts*, it's UI. If it describes a mechanism that exists below the UI layer, it's Arch.

Individual primitive docs are populated in P2 of GH#135.
