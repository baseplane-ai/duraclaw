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
