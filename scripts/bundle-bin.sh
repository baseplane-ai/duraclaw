#!/usr/bin/env bash
# bundle-bin.sh — bundle a TypeScript entry into a self-contained Bun binary.
#
# Replaces tsup for the three VPS-deployed packages (agent-gateway,
# session-runner, docs-runner). `bun build --target=bun` inlines workspace
# and npm deps, so the resulting file has no on-disk node_modules dependency
# at runtime — which is what makes mid-pipeline `pnpm install` safe.
#
# Atomic-rename invariant: the bundle is written to a staging directory
# first, then moved into place via `mv`, so a fresh runner spawn can never
# read a half-written file even if the pipeline rewrites the bundle while
# the gateway is running.
#
# Note: bun (1.3.x) has a quirk where `--outfile <relative-path>.tmp`
# reports success but silently drops the output. Using `--outdir` with an
# absolute path sidesteps it.
#
# Usage: bundle-bin.sh <entry> <outfile> [--shebang]

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: bundle-bin.sh <entry> <outfile> [--shebang]" >&2
  exit 64
fi

entry="$1"
outfile="$2"
shebang_flag="${3:-}"

# Resolve to absolute paths so bun-build behaves predictably and so the
# atomic mv doesn't depend on CWD at any step.
outfile_abs="$(cd "$(dirname "$outfile")" 2>/dev/null && pwd || (mkdir -p "$(dirname "$outfile")" && cd "$(dirname "$outfile")" && pwd))/$(basename "$outfile")"
out_dir="$(dirname "$outfile_abs")"
out_base="$(basename "$outfile_abs")"

stage_dir="${out_dir}/.bundle-stage"
rm -rf "$stage_dir"
mkdir -p "$stage_dir"

# bun build --outdir writes <basename-of-entry>.js into the dir.
entry_base="$(basename "$entry" .ts)"  # e.g. main.ts -> main
bun build --target=bun "$entry" --outdir "$stage_dir" --sourcemap=linked

staged="${stage_dir}/${entry_base}.js"
if [[ ! -s "$staged" ]]; then
  echo "bundle-bin: expected $staged but got nothing" >&2
  ls -la "$stage_dir" >&2 || true
  exit 1
fi

if [[ "$shebang_flag" == "--shebang" ]]; then
  # Prepend `#!/usr/bin/env bun` to the staged file in-place so the final
  # mv lands an already-executable, already-shebang'd artifact.
  prefixed="${stage_dir}/.shebang.tmp"
  printf '#!/usr/bin/env bun\n' > "$prefixed"
  cat "$staged" >> "$prefixed"
  mv "$prefixed" "$staged"
  chmod 755 "$staged"
fi

# Move the .map first (consumers tolerate a missing or stale map far more
# than they tolerate a stale binary).
if [[ -f "${staged}.map" ]]; then
  mv -f "${staged}.map" "${outfile_abs}.map"
fi

# Atomic rename: a fresh spawn either sees the old (still-valid) bundle
# or the new one — never a half-written one.
mv -f "$staged" "$outfile_abs"

rm -rf "$stage_dir"
