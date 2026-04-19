# Phase Devcontainer Evidence

Date: 2026-04-19
Issue: [#19](https://github.com/baseplane-ai/duraclaw/issues/19)
Branch: `feature/19-devcontainer-codespaces`

Scope covered in this pass:

- `.devcontainer/devcontainer.json` — base image, features, port forwards, VS Code config.
- `.devcontainer/post-create.sh` — corepack + pnpm install + prepare hooks.
- `.devcontainer/README.md` — first-run checklist, credentials pointer.
- `scripts/verify/devcontainer.sh` + `pnpm verify:devcontainer` — static config check.

## Local verification run

```
$ pnpm verify:devcontainer

[.devcontainer presence]
devcontainer.json found
post-create.sh found
post-create.sh is executable

[devcontainer.json shape]
Required fields present
Forward ports 43173 / 9877 / 8787 declared
Bun feature declared

[post-create.sh sanity]
post-create.sh parses

[summary]
Devcontainer config OK. Build + runtime verification lives in .kata/verification-evidence/.
```

## Container build + preflight

Not run on the authoring host (Docker Desktop not installed). Baseline smoke of
config correctness is captured above. Build + in-container preflight is
expected to be produced by the first contributor who merges the branch into a
runtime with Docker + `devcontainer-cli`; paste the run output into this file
under a new `## Container build + preflight` section and commit the update.

Expected contents when captured:

- `devcontainer build --workspace-folder .` — image build log tail.
- `devcontainer exec --workspace-folder . -- pnpm install --frozen-lockfile` — passes.
- `devcontainer exec --workspace-folder . -- pnpm verify:preflight` — passes or
  documented blocker (e.g. requires CF auth inside the container, which is a
  one-time user step, not part of the config).

## Baseline smoke

- `pnpm verify:smoke` — not re-run for this PR (no changes to orchestrator, gateway,
  transport, or auth). The change set is limited to new files under
  `.devcontainer/`, a new verify script, and a new `package.json` script entry.
  Rerun before merge per repo policy.
