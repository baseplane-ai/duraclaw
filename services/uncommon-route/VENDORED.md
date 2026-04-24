# Vendored: UncommonRoute

This directory is a vendored copy of [`anjieyang/IYKYK`](https://github.com/anjieyang/IYKYK)
(the upstream UncommonRoute router), brought into the Duraclaw monorepo so
that:

1. Every change to the router — including features driven by Duraclaw's
   autoagent/autoresearch loop — lands as a reviewable PR **against this
   repo**, not a fork far upstream.
2. Duraclaw CI can exercise the router directly against
   `@duraclaw/router-client` (see `packages/router-client`) and the
   session-runner integration.
3. Operators deploying Duraclaw get a known-good router version pinned to
   the monorepo commit, not a floating upstream.

## Upstream provenance

| Field        | Value                                                      |
| ------------ | ---------------------------------------------------------- |
| Upstream     | https://github.com/anjieyang/IYKYK                         |
| Package      | `uncommon-route` (PyPI)                                    |
| Vendored at  | commit `563bb76bc8515bfaf872edb3864275a644f45ca9` (v0.3.1) |
| License      | Modified MIT (see `LICENSE`)                               |

## What's included vs excluded

Included:

- `uncommon_route/` — the runtime package (proxy, router, calibration, CLI).
- `tests/` — pytest suite (315 tests pass with the ignores below).
- `bench/` — training + eval data used by a subset of the tests.
- `openclaw-plugin/` — Node plugin sibling (already imports from the Python package).
- `pyproject.toml`, `LICENSE`, `README.md`, `README.zh-CN.md`, `CONTRIBUTING.md`, `SECURITY.md`.

Excluded at the vendor drop (can be pulled in later if needed):

- `frontend/` — dashboard. Not needed for the router to run.
- `demo/`, `docs/`, `scripts/`, `api.py` — comparison tooling + legacy shim.
  Independent of runtime behaviour.

## Running from the vendor directory

```bash
cd services/uncommon-route
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

# tests
pytest -q

# lint
ruff check .

# serve the proxy
uncommon-route serve --port 8403
```

## Policy

- **No upstream-silent drift.** Every functional change here ships with the
  motivation written in the commit message + the PR body. When we want an
  upstreamable patch, we cherry-pick + open a PR against `anjieyang/IYKYK`
  separately; the version that runs Duraclaw always remains this tree.
- **Re-vendor by replace, not merge.** When we bump the pinned commit,
  re-run the drop (copy the upstream tree, preserve our own changes on top
  via a rebase branch). Record the new upstream SHA in the table above.
- **Don't touch `tests/test_bench.py` or `tests/test_model_experience.py`
  until upstream fixes them.** Both have pre-existing collection errors on
  upstream `main` (missing imports in `uncommon_route.__init__`); they're
  already on the ignore list for the vendored run.
