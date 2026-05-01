# Deployment

All deploys are handled by the infra server — pushing to `main` on `origin`
triggers the pipeline that builds and ships both the orchestrator (CF
Workers) and the agent-gateway (systemd on VPS). Do not run `pnpm ship`,
`wrangler deploy`, or the gateway install script manually.

**Infra-pipeline contract for mobile OTA** — during the GH#132 P3
sunset window the pipeline runs **two parallel OTA channels** against
the same `duraclaw-mobile` R2 bucket (key namespaces don't overlap):

  (a) Build the orchestrator with `VITE_APP_VERSION` stamped in.
  (b) **Capacitor channel (sunsetting — `apps/mobile/`)**: run
      `scripts/build-mobile-ota-bundle.sh` with `CLOUDFLARE_API_TOKEN`
      + `CLOUDFLARE_ACCOUNT_ID` in-env so the script uploads the zip
      + the `ota/version.json` pointer. Removed in the post-merge
      cleanup follow-up.
  (c) **Expo channel (GA — `apps/mobile-expo/`, GH#132 P3.4)**: run
      `scripts/build-mobile-expo-ota.sh` with the same secrets so the
      script `expo export`s the JS bundle + assets, uploads per-update
      objects under `ota/expo/<runtimeVersion>/<platform>/<updateId>/`,
      and atomically writes the channel pointer
      `ota/expo/<runtimeVersion>/<platform>/<channel>/latest.json`
      LAST. The pointer-last write order means a partial upload never
      breaks the `/api/mobile/eas/manifest` route (Worker reads the
      pointer first; missing pointer = "no update available" 404).

Without (b) the legacy Capgo channel is dead. Without (c) the Expo
channel is dead — every Expo APK polls `/api/mobile/eas/manifest`,
sees no manifest, and stays on the bundle the APK shipped with.

**Expo runtimeVersion strategy** — `'fingerprint'` (set in
`apps/mobile-expo/app.json`). Bumping a native dep changes the
fingerprint; the new fingerprint's manifest is uploaded only after a
fresh APK is built and installed (otherwise old-runtime clients
crash on the new bundle). Old runtime version's clients ignore the
new manifest (the manifest endpoint returns 404 for their
fingerprint), so they stay on their bundle until they install the
new APK. JS-only changes (no native dep change) ship as
same-fingerprint OTA updates.

```bash
export APP_VERSION=$(git rev-parse --short HEAD)
VITE_APP_VERSION="$APP_VERSION" \
  pnpm --filter @duraclaw/orchestrator build

# Capacitor (sunsetting)
bash scripts/build-mobile-ota-bundle.sh         # emits zip + version.json locally
# Expo (GA)
bash scripts/build-mobile-expo-ota.sh           # uploads per-update + pointer to R2

# Infra pipeline uploads (b)'s zip + version.json to R2 and runs (c)
# in-line via wrangler r2 object put (CLOUDFLARE_* env vars from secrets).
# Apply pending D1 migrations BEFORE deploying the Worker so the
# request-path schema is in sync with the code about to start serving.
pnpm --filter @duraclaw/orchestrator db:migrate:remote
wrangler deploy --cwd apps/orchestrator
```

**D1 migrations are part of the deploy contract** — `wrangler deploy`
does not run them, and `migrations/meta/_journal.json` is generated at
codegen time so its presence on disk does not imply the migrations have
been applied to remote D1. Skip this step and any newly-added column or
table breaks every authed page-load with `D1_ERROR: no such table/column`.
The apply is idempotent (wrangler tracks applied filenames in its own
`d1_migrations` table) so re-running it on a no-op deploy is safe.

**Infra-pipeline contract for the VPS gateway + runners** — the gateway
(`packages/agent-gateway`) and its two spawn targets (`session-runner`,
`docs-runner`) ship as **self-contained Bun bundles**. The pipeline runs:

```bash
git pull
pnpm install --frozen-lockfile
pnpm --filter '@duraclaw/agent-gateway' \
     --filter '@duraclaw/session-runner' \
     --filter '@duraclaw/docs-runner' \
     build                              # produces dist/{server,main}.js bundles
sudo cp packages/agent-gateway/systemd/duraclaw-agent-gateway.service \
        /etc/systemd/system/             # only if the unit changed
sudo systemctl daemon-reload             # only after a unit copy
sudo systemctl restart duraclaw-agent-gateway
```

Why bundles (not source / not tsup):
- Gateway runs from `dist/server.js`, not `src/server.ts` — `git pull`
  rewriting source files is harmless to the running process.
- Session-runner and docs-runner bundles inline their workspace deps
  (`shared-transport`, `shared-types`, the SDK), so a runner spawned at
  T+0 is unaffected by `pnpm install` rewriting `node_modules` at T+1.
  Runners load their bundle once at spawn and never re-read disk.
- `scripts/bundle-bin.sh` writes via a staging dir + atomic `mv`, so a
  spawn that races with a pipeline-time bundle rewrite always reads
  either the old or the new bundle, never a half-written one.

Because of those three properties, the pipeline does NOT need a
stop-before-pull window or an early-start step — the gateway stays up
through pull/install/build, and only restarts after the new bundle is
in place. The unit file uses `KillMode=process` so detached runner
children are unaffected by the gateway restart.
