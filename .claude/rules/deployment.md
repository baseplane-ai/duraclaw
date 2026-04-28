# Deployment

All deploys are handled by the infra server — pushing to `main` on `origin`
triggers the pipeline that builds and ships both the orchestrator (CF
Workers) and the agent-gateway (systemd on VPS). Do not run `pnpm ship`,
`wrangler deploy`, or the gateway install script manually.

**Infra-pipeline contract for mobile OTA** — the pipeline must (a)
build the orchestrator with `VITE_APP_VERSION` stamped in, and (b)
run `scripts/build-mobile-ota-bundle.sh` with `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID` in-env so the script uploads the zip + the
`ota/version.json` pointer to the `duraclaw-mobile` R2 bucket. Without
step (b) the OTA channel is dead — every native shell polls, sees no
newer version, and stays on the bundle the APK shipped with.

```bash
export APP_VERSION=$(git rev-parse --short HEAD)
VITE_APP_VERSION="$APP_VERSION" \
  pnpm --filter @duraclaw/orchestrator build
bash scripts/build-mobile-ota-bundle.sh   # emits zip + version.json locally
# Infra pipeline uploads the zip + version.json to R2 (duraclaw-mobile bucket)
# and then deploys the Worker.
wrangler deploy --cwd apps/orchestrator
```

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
