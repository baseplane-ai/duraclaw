---
paths:
  - "packages/kata/**"
---

# Kata (Workflow CLI)

- Full source lives in `packages/kata/` (migrated from external `kata-wm` repo).
  Not published to npm — clone-and-run-from-source via Bun.
- 8 modes: planning, implementation, research, task, debug, verify, freeform, onboard
- Phase tracking, stop condition gates, session persistence
- Run via `kata enter <mode>`
- **CLI**: `src/index.ts` has `#!/usr/bin/env bun` shebang — runs TypeScript
  directly, no build step. `scripts/link-kata.sh` creates `~/.local/bin/kata`
  symlink + runs `bun install`. Called automatically by `setup-clone.sh`.
- Dependencies: `js-yaml`, `zod` (runtime); `bun` (execution)
