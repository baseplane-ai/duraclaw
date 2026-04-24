#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

lint_only=0

case "${1:-}" in
  "")
    ;;
  --lint-only)
    lint_only=1
    ;;
  *)
    echo "Unknown argument: ${1}" >&2
    exit 1
    ;;
esac

printf 'Running Biome on staged JS/TS/JSON files...\n'
staged_files="$(
  git diff --cached --name-only --diff-filter=ACMR |
    grep -E '\.(ts|tsx|js|jsx|json)$' |
    grep -v 'routeTree\.gen\.ts$' |
    grep -v '\.config\.' |
    grep -v '^packages/kata/' || true
)"

if [[ -n "$staged_files" ]]; then
  printf '%s\n' "$staged_files" | xargs pnpm exec biome check --error-on-warnings
  printf 'Biome checks passed.\n'
else
  printf 'No staged JS/TS/JSON files to lint.\n'
fi

if [[ "$lint_only" -eq 1 ]]; then
  exit 0
fi

printf '\nRunning typecheck...\n'
pnpm typecheck
printf 'Typecheck passed.\n'
