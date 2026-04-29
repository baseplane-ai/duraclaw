# AI Elements

> The catalog of agent-conversation UI primitives — Message, Tool, Reasoning, Conversation, and friends — described by behavior contract, not by component file.

## Layer test

This primitive survives a stack rewrite but NOT a UI redesign. The package is currently a React component library wrapping Radix and Streamdown; a future stack would need to expose the same set of behavior contracts (a streaming Message, an expandable Tool, a Reasoning block, a stick-to-bottom Conversation) under whichever component model it uses. If the visual model of "what a Message looks like" changes, this doc changes.

## Behavior contract

The catalog provides the building blocks for rendering a Claude session: a turn of conversation, a tool invocation, a reasoning block, the scroll surface that holds them, the prompt input that drives them, and the auxiliary surfaces (sources, suggestions, plans, tasks) that decorate them. Every primitive is *streaming-aware* — it has to render correctly while text is still arriving, not just on a finalised payload.

## Catalog

### Message

Renders one turn of conversation. Carries a `from` role (user / assistant) so user turns and assistant turns can take visually distinct shapes. Supports streaming partials with progressive reveal — partial text appears as it arrives without re-laying-out completed children. Optional sub-parts: a content area for the prose, an actions row for per-turn affordances, and arbitrary children for tool-use, reasoning, sources, and similar inline blocks.

### Conversation

The scroll surface that holds a sequence of Messages. Owns the **stick-to-bottom** behavior contract: while the user is at the bottom of the thread, new content keeps the viewport pinned to the latest line; if the user scrolls up to read history, new content does not yank them back. A scroll-to-bottom affordance reappears once the user is detached, and clicking it re-engages the pin. Honours text-selection (does not break a cross-message highlight when a delta lands) and content-shrink (rewind / branch-navigate keeps the pin sane).

### Tool

Renders a tool invocation as an expandable block with its inputs, outputs, and a status indicator. States it must surface: `pending` (input still streaming), `running` (input ready, output not yet available), `awaiting approval` (gated tool waiting on a user decision), `completed` (output available), `denied` (user refused), `errored`. Header carries the tool name + status icon; body holds the inputs and outputs, collapsed by default once the tool has settled.

### Reasoning

An expandable block for the model's reasoning trace. Streams text in while it's arriving; auto-collapses a short delay after streaming ends so the reasoning doesn't dominate the thread once a turn is finished. User can re-open it manually. Tracks duration so the collapsed header can carry a "thought for Ns" affordance.

### ChainOfThought

A structured reasoning surface — multiple labelled steps rendered as an ordered list with status indicators per step. Different from Reasoning (free-form prose); ChainOfThought is the contract for "the model emitted a numbered plan and is working through it."

### PromptInput

The chat input surface. Carries the textarea, send / interrupt affordances, attachment surface, and any model / mode selectors. Streaming-aware: while the agent is working, the input shifts into an interrupt-affordance state rather than a send state. The input itself is the integration surface for the collaborative-draft primitive (see `tabs-and-drafts.md`).

### Tool ancillaries (Plan, Task, Checkpoint, WorkflowProgress, TestResults, StackTrace, FileTree, CodeBlock, Terminal)

Specialised renderers for common tool outputs. Each has a tight visual contract — a Plan is an ordered checklist with per-item state; a Task is a single-step status row; a Checkpoint is a saved-state marker; WorkflowProgress is a multi-stage progress strip; TestResults is a pass/fail/pending grid; StackTrace is a foldable error trace; FileTree is a clickable hierarchy; CodeBlock and Terminal are syntax-highlighted code surfaces. The contract is "the data shape is well-known, so the renderer is a primitive, not a per-feature widget."

### Sources, InlineCitation, Suggestion

Citation and follow-up affordances. Sources renders a deduplicated list of references the assistant pulled from; InlineCitation is a numbered marker inside prose linking to one of those sources; Suggestion is a clickable follow-up prompt the user can fire with one click.

### Presence and connection (Persona, Connection, Loader, Shimmer)

Lightweight status primitives. Persona surfaces who is speaking; Connection surfaces transport health; Loader and Shimmer are the canonical "something is happening" affordances.

### Canvas, Node, Edge, WebPreview, Sandbox, JsxPreview

Rich-output primitives — a pannable canvas with nodes and edges, an iframed web preview, a sandboxed code preview, a JSX preview. Each has the same core contract: a side panel or inline surface that renders a non-text artefact the model produced.

## Where this lives in code

- `packages/ai-elements/src/components/` — each primitive is one file; the package re-exports them through `src/index.ts`.
- `packages/ai-elements/src/ui/` — the lower-level token-driven components (button, badge, dialog, tabs, …) that the conversation primitives compose on.
- `packages/ai-elements/src/lib/tool-display.ts` — shared mapping from tool-state to label/icon used by Tool and Tool ancillaries.
