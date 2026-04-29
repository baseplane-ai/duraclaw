# Duraclaw Knowledge Tree

This tree is duraclaw's layered knowledge hierarchy, modelled on baseplane's docs stack: **Theory** describes invariants, **Primitives** describes stack-independent building blocks, **Modules** describes per-package surfaces, **Integrations** describes external dependencies, and **Specs** + **Rules** capture in-flight feature design and code-level patterns respectively. Everything here is plain markdown — there is no renderer, no docs site, no publish workflow. The discipline is organisational: every piece of knowledge has exactly one correct home, and the layer tests below tell you which.

## Hierarchy

| Layer | Location | Contents | Changes-When |
|----|----|----|----|
| **Theory** | `docs/theory/` | 6 fixed categorical files describing duraclaw invariants | Behavior of the system changes |
| **Primitives** | `docs/primitives/{ui,arch}/` | Stack-independent building blocks | A primitive's behavior contract changes |
| **Modules** | `docs/modules/` | One file per package, surface + ownership | A package's public surface changes |
| **Integrations** | `docs/integrations/` | One file per external dependency | An external dep's version/scope/footprint changes |
| **Specs** | `planning/specs/` | In-flight features, frozen on land | A feature is being designed or revised |
| **Rules** | `.claude/rules/` | Code-level patterns auto-attached to AI sessions via `paths:` | A code pattern needs to be reinforced |

## Layer Tests

Each layer earns its keep by surviving one kind of change while NOT surviving another. If a doc would survive both, it's misplaced.

| Layer | Survives... | But NOT... |
|----|----|----|
| Theory | a stack rewrite | a behavior change |
| Primitives | a stack rewrite | a UI redesign |
| Modules | a UI redesign | a package being deleted/merged |
| Integrations | a refactor | swapping the external dependency |
| Specs | the feature shipping | the feature being unshipped |
| Rules | a code refactor inside `paths:` scope | the pattern being abandoned |

## Disambiguation Shortcuts

- If it's a file path or class name → it belongs in a Module or Rule, not Theory or Primitives.
- If it's an abstract invariant about how the system must behave → Theory.
- If it's a wireframe / behavior contract / building block → Primitive.
- If it's a single in-flight feature with a GitHub issue → Spec.
- If it's a single domain entity with a lifecycle → Theory (`domains.md`) or a Module that owns it.

## `docs/` is not `packages/docs-runner/`

This `docs/` tree is the knowledge hierarchy you are reading — plain markdown, no runtime, no server. It is unrelated to `packages/docs-runner/`, which is the live yjs collaborative-document feature: a Bun-bundled runner that runs on the VPS, dial-backs to a `DocsRunnerDO`, and serves real-time multi-user editing for in-app documents. The naming overlap is unfortunate; if you came here looking for the docs-runner package, head to `packages/docs-runner/` and `planning/specs/27-docs-as-yjs-dialback-runners.md`.

## Sibling concerns (not hierarchy rows)

Two folders sit alongside the main layers but are intentionally NOT rows in the hierarchy table above:

- `docs/testing/` — manual testing recipes (long-lived test data, walkthroughs, environment setup) that don't fit alongside automated tests next to code.
- `docs/_archive/` — dropzone for dissolved layers and superseded docs, kept for git-blame and reading-order recovery.

These exist because they're useful, not because they're load-bearing layers. They have no Layer Test because they don't compete for content with the main hierarchy.
