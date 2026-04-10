---
date: 2026-04-10
topic: Unified packaging — cc-gateway + mdsync + system tray
status: complete
github_issue: null
---

# Research: Unified Packaging with System Tray (cc-gateway + mdsync)

## Context

Duraclaw has two VPS-side services that will need to be installed together:

1. **cc-gateway** — Bun WebSocket server wrapping Claude Agent SDK (port 9877, systemd)
2. **mdsync** — Bun-based markdown sync engine with Yjs real-time layer (spec 0008)

Both are Bun/TypeScript, both run as long-lived daemons, and both need status visibility. The mdsync spec (0008 Phase 6) already plans a Tauri v2 tray app. This research explores whether to unify them under a single install + tray app, and what the best architecture is for Linux/macOS/Windows.

## Questions Explored

1. What's the best cross-platform tray framework?
2. How should the tray app supervise the two services?
3. What packaging/installer approach works across all three platforms?
4. How do comparable products (Ollama, Tailscale, Docker Desktop) solve this?
5. Can `bun build --compile` produce distributable binaries?

## Findings

### 1. Cross-Platform Tray Frameworks

| Framework | Language | Binary Size | Tray-Only? | Child Process Mgmt | Installer Bundler |
|-----------|----------|-------------|------------|--------------------|--------------------|
| **Tauri v2** | Rust + Web UI | ~3-8 MB | Yes (empty windows array) | Sidecar plugin (ships binaries, manages lifecycle) | Built-in: DMG, MSI/NSIS, deb, rpm, AppImage |
| **Electron** | JS | ~80-150 MB | Yes (BrowserWindow hidden) | child_process | electron-builder |
| **Go systray** | Go | ~10-15 MB | Yes | os/exec | Manual (goreleaser) |
| **node-systray** | Node | ~50 MB (with node) | Yes | child_process | pkg or nexe |

**Winner: Tauri v2.** Already chosen in mdsync spec Phase 6. Key advantages:
- Smallest binary size (~3-8 MB for the tray shell)
- Built-in cross-platform bundler (DMG, MSI, NSIS, deb, rpm, AppImage)
- First-class sidecar support — bundles external binaries with target-triple suffixes, manages spawn/kill lifecycle
- Tray-only mode works: set `"windows": []` in tauri.conf.json
- Can optionally show a webview window (activity log, settings) on tray click
- Auto-update via `tauri-plugin-updater`

Sources:
- [Tauri v2 System Tray docs](https://v2.tauri.app/learn/system-tray/)
- [Tray-only Tauri app guide](https://dev.to/daanchuk/how-to-create-a-tray-only-tauri-app-2ej9)
- [Tauri v2 Sidecar docs](https://v2.tauri.app/develop/sidecar/)
- [Tauri distribution docs](https://v2.tauri.app/distribute/)

### 2. Comparable Product Architectures

**Ollama:**
- Go single binary for the daemon (`ollama serve`)
- Electron wrapper for desktop app (spawns daemon as child process)
- macOS: .app bundle (Electron), Windows: OllamaSetup.exe (NSIS)
- Tray icon shows status, menu has start/stop/logs
- Desktop app is optional — CLI + daemon works standalone

**Tailscale:**
- **Daemon + client separation** — `tailscaled` (system service) + `tailscale` (CLI client)
- Communication via local HTTP API over Unix socket (Linux/macOS) or named pipe (Windows)
- Tray app is a separate process that talks to daemon via same local API
- On some platforms, CLI is embedded into daemon binary for space efficiency
- Has their own Go systray fork (`github.com/tailscale/systray`)

**Docker Desktop:**
- Electron app manages a Linux VM (HyperKit/WSL2)
- Tray icon for start/stop/settings
- Heaviest approach — not a good model for lightweight services

**Key Pattern:** All three use **daemon + tray as separate processes**, communicating via local HTTP/socket API. The tray app is a thin supervisory shell.

Sources:
- [Ollama Desktop Architecture (DeepWiki)](https://deepwiki.com/ollama/ollama/7.3-desktop-application)
- [Tailscale Daemon Architecture (DeepWiki)](https://deepwiki.com/tailscale/tailscale/3.2-tailscaled)
- [Tailscale CLI Architecture (DeepWiki)](https://deepwiki.com/tailscale/tailscale/6.1-tailscale-cli-architecture)

### 3. Bun Compile Status (April 2026)

`bun build --compile` is mature and supports cross-compilation:

```bash
bun build --compile --target=bun-linux-x64 ./src/server.ts --outfile cc-gateway
bun build --compile --target=bun-darwin-arm64 ./src/server.ts --outfile cc-gateway
bun build --compile --target=bun-windows-x64 ./src/server.ts --outfile cc-gateway.exe
```

- Produces self-contained binary (Bun runtime + bundled code)
- Cross-compile from any platform to linux-x64, darwin-arm64, windows-x64
- Binary size: ~50-80 MB (includes Bun runtime)
- Limitation: Windows icon/console flags can't be set when cross-compiling
- Note: Bun was acquired by Anthropic in Dec 2025 — deeply integrated with Claude ecosystem now

Sources:
- [Bun single-file executable docs](https://bun.com/docs/bundler/executables)
- [Bun cross-compilation](https://developer.mamezou-tech.com/en/blogs/2024/05/20/bun-cross-compile/)

### 4. Tauri Sidecar Pattern (Recommended Architecture)

Tauri v2's sidecar feature is purpose-built for this use case:

```
apps/duraclaw-tray/
  src-tauri/
    binaries/
      cc-gateway-x86_64-unknown-linux-gnu       # bun-compiled
      cc-gateway-aarch64-apple-darwin
      cc-gateway-x86_64-pc-windows-msvc.exe
      mdsync-x86_64-unknown-linux-gnu
      mdsync-aarch64-apple-darwin
      mdsync-x86_64-pc-windows-msvc.exe
    tauri.conf.json
    src/
      main.rs                                    # Tray setup, sidecar lifecycle
  src/
    App.tsx                                      # Status UI (shown on tray click)
```

**How it works:**
1. Tauri bundles the Bun-compiled binaries as sidecars (with target-triple suffixes)
2. On startup, Rust code spawns both sidecars via `app.shell().sidecar("cc-gateway")`
3. Tray icon reflects aggregate status (green = both healthy, yellow = degraded, red = error)
4. Each service exposes `/health` — tray polls for status
5. Tauri bundler produces platform-specific installers automatically
6. Auto-start: launchd plist (macOS), systemd user unit (Linux), registry (Windows)

**Permissions in Tauri:**
```json
{
  "permissions": [
    "shell:allow-execute",
    "shell:allow-spawn",
    "tray-icon:default"
  ]
}
```

### 5. Headless Linux VPS Mode

On a headless VPS, there's no display server for a tray icon. Two approaches:

**Option A: Tray app is desktop-only, systemd for VPS**
- VPS: systemd services (current cc-gateway model), no tray
- Desktop: Tauri tray app manages both services as sidecars
- Status on VPS: `curl localhost:9877/health` or TUI

**Option B: Unified binary with headless mode**
- Single supervisor binary that detects display availability
- With display: show tray icon
- Without display: run as daemon, expose HTTP status endpoint
- Same binary, same config, different presentation

Option A is simpler and matches current reality. Option B is elegant but adds complexity.

**Recommendation: Option A.** Ship the Tauri tray app for desktop installs, keep systemd for VPS. The tray app uses the same Bun-compiled binaries as sidecars. The VPS install script installs just the binaries + systemd units.

## Architecture Recommendation

```
┌─────────────────────────────────────────────────┐
│              Duraclaw Tray (Tauri v2)            │
│  Rust: tray icon, sidecar lifecycle, auto-start │
│  Web:  status dashboard (optional webview)      │
│                                                  │
│  Sidecars:                                       │
│  ├── cc-gateway (Bun-compiled binary)            │
│  │   Port 9877, WebSocket + HTTP                 │
│  │   GET /health → { status, uptime, sessions }  │
│  │                                               │
│  └── mdsync (Bun-compiled binary)                │
│      Configurable port, HTTP                     │
│      GET /health → { status, syncing, errors }   │
│      Writes .mdsync/state.json for status        │
└─────────────────────────────────────────────────┘

VPS mode (no tray):
  systemd: duraclaw-cc-gateway.service
  systemd: duraclaw-mdsync.service
  Both use same Bun-compiled binaries
```

## Options Comparison

| Option | Description | Pros | Cons | Fit |
|--------|-------------|------|------|-----|
| **A: Tauri tray + Bun sidecars** | Tauri manages Bun-compiled services as sidecars | Small binary, built-in bundler, sidecar lifecycle, auto-update, already in mdsync spec | Two runtimes (Rust tray + Bun services), ~130 MB total install | **High** |
| **B: Electron tray + Bun sidecars** | Electron shell spawns Bun services | Rich UI, familiar JS stack | 150+ MB, high memory, no sidecar convention | Low |
| **C: Go supervisor + Bun sidecars** | Go binary for tray + process management | Small tray binary (~15 MB) | No bundler, manual installer setup, new language | Med |
| **D: Bun-only (no tray binary)** | Bun process manages sub-services, systray via npm | Single runtime | node-systray is fragile, no bundler, poor native integration | Low |
| **E: Rewrite services in Rust** | Everything in Rust + Tauri | Smallest install, single runtime | Massive rewrite, lose BlockNote/Yjs/Agent SDK ecosystem | None |

## Recommendations

### Primary: Option A — Tauri v2 Tray + Bun Compiled Sidecars

1. **Monorepo structure:**
   - `packages/mdsync/` — core sync engine (already planned)
   - `packages/cc-gateway/` — agent gateway (exists)
   - `apps/duraclaw-tray/` — Tauri v2 tray app (replaces `apps/mdsync-tray/`)

2. **Build pipeline:**
   - `bun build --compile` each service for each target triple
   - Tauri bundler wraps them as sidecars + produces installers
   - CI: GitHub Actions with `tauri-action` for cross-platform builds

3. **Service communication:**
   - Each service exposes `GET /health` (already done for cc-gateway)
   - Tray polls health endpoints every 5s
   - Tray shows aggregate status icon
   - Optional: webview window with activity log, config, per-service controls

4. **Install modes:**
   - **Desktop:** Download installer (DMG/MSI/deb) → Tauri app with bundled sidecars
   - **VPS headless:** Download binaries + run install script → systemd services
   - Same binaries for both modes

5. **Naming change:** The tray app should be called "Duraclaw" (not "mdsync-tray") since it manages all local services. Update spec 0008 Phase 6 accordingly.

### Migration from spec 0008

- Phase 6 currently says `apps/mdsync-tray/` — rename to `apps/duraclaw-tray/`
- Tray manages both mdsync AND cc-gateway (not just mdsync)
- Phase 7 (infra integration) stays the same — VPS uses systemd, reads state.json

## Open Questions

1. **Config unification** — Should there be a single `duraclaw.yaml` that configures both services, or keep separate configs (`mdsync.yaml` + cc-gateway env)?
2. **Auto-update** — Tauri's updater can update the tray app, but how do we update the sidecar binaries? Bundle them inside the Tauri update, or separate update channel?
3. **Port conflicts** — Both services need ports. Should we assign fixed defaults (9877, 9878) or use dynamic port allocation with a config file?
4. **VPS install script** — Current `install.sh` is cc-gateway only. Need a unified installer that sets up both systemd services.

## Next Steps

- Update spec 0008 Phase 6: rename `apps/mdsync-tray/` → `apps/duraclaw-tray/`, expand scope to manage cc-gateway
- Create a new spec for the unified packaging/installer system
- Prototype: scaffold Tauri v2 tray-only app with one Bun sidecar
