---
initiative: feat-unified-tray
type: project
issue_type: feature
status: approved
priority: high
github_issue: 15
created: 2026-04-10
updated: 2026-04-10
phases:
  - id: p1
    name: "Scaffold Tauri v2 App + Tray Icon + Single Sidecar (cc-gateway)"
    tasks:
      - "Initialize Tauri v2 project at apps/duraclaw-tray with Rust backend and React frontend"
      - "Configure tray-only mode (empty windows array in tauri.conf.json)"
      - "Create tray icon assets: green (healthy), yellow (degraded), red (error), grey (stopped)"
      - "Implement Rust tray menu with static layout: service status line, Start/Stop, Quit"
      - "Add shell:allow-execute and tray-icon:default permissions in capabilities"
      - "Compile cc-gateway with bun build --compile for host platform"
      - "Place compiled binary in src-tauri/binaries/ with target-triple suffix"
      - "Implement sidecar spawn on app startup via app.shell().sidecar()"
      - "Implement sidecar kill on app quit (drop guard in Rust)"
      - "Poll cc-gateway GET /health every 5s from Rust, update tray icon color"
    test_cases:
      - id: "p1-tray-renders"
        description: "Tauri app launches, tray icon appears in system tray"
        type: "smoke"
      - id: "p1-sidecar-spawns"
        description: "cc-gateway binary starts as sidecar, GET /health returns 200"
        type: "integration"
      - id: "p1-tray-icon-reflects-health"
        description: "Tray icon turns green when /health returns ok, red when service is down"
        type: "integration"
  - id: p2
    name: "Add mdsync Sidecar + Health Polling + Unified Config"
    tasks:
      - "Add mdsync as second sidecar binary (bun build --compile, target-triple suffix)"
      - "Implement duraclaw.yaml config parser in Rust (serde_yaml)"
      - "Config sections: gateway (port, env_file), mdsync (port, watch_paths), tray (poll_interval_ms)"
      - "Emit Tauri events from Rust health poller to frontend (health-update custom event)"
      - "Update tray menu to show per-service status lines with session/file counts from /health"
      - "Implement aggregate status logic: green = all healthy, yellow = partial, red = all down"
      - "Write default duraclaw.yaml on first launch if not present"
      - "Implement Open Config menu action (opens duraclaw.yaml in default editor)"
      - "Implement hybrid supervision: check /health before spawning sidecar, attach if already running"
      - "Track externally-managed vs self-managed services, skip kill-on-quit for external"
    test_cases:
      - id: "p2-dual-sidecar"
        description: "Both cc-gateway and mdsync sidecars spawn and respond to /health"
        type: "integration"
      - id: "p2-config-loads"
        description: "duraclaw.yaml is parsed and port/paths applied to sidecar spawn args"
        type: "unit"
      - id: "p2-aggregate-status"
        description: "Tray icon shows yellow when one service is down, green when both up"
        type: "integration"
      - id: "p2-hybrid-attach"
        description: "Tray attaches to manually-started cc-gateway without spawning a duplicate"
        type: "integration"
      - id: "p2-config-corrupt"
        description: "Corrupted duraclaw.yaml causes fallback to defaults, not a crash"
        type: "unit"
  - id: p3
    name: "Headless Mode + systemd Integration"
    tasks:
      - "Add --headless CLI flag to Tauri binary (detect via std::env::args)"
      - "In headless mode: do not call tauri::Builder, run standalone tokio supervisor with tokio::process::Command for sidecars"
      - "Expose HTTP status endpoint in headless mode on configurable port (default 9870)"
      - "Status endpoint returns JSON: services array with name, status, uptime, port"
      - "Create systemd unit file: duraclaw-tray.service (Type=simple, ExecStart with --headless)"
      - "Implement display detection fallback: if DISPLAY/WAYLAND_DISPLAY unset on Linux, auto-headless"
      - "Add --status CLI flag that queries headless status endpoint and prints table"
      - "Write install-headless.sh script that copies binary + creates systemd unit + writes default config"
    test_cases:
      - id: "p3-headless-starts"
        description: "Binary with --headless starts without display, no tray error"
        type: "integration"
      - id: "p3-status-endpoint"
        description: "GET /status on headless port returns JSON with both service states"
        type: "integration"
      - id: "p3-systemd-unit"
        description: "systemd unit starts headless supervisor, survives restart"
        type: "smoke"
  - id: p4
    name: "Auto-Start, Auto-Update, Notifications"
    tasks:
      - "Implement auto-start on login: launchd plist (macOS), systemd user unit (Linux), registry run key (Windows)"
      - "Add tauri-plugin-updater dependency and configure update endpoint URL in tauri.conf.json"
      - "Implement update check on startup + periodic check every 6 hours"
      - "Show system notification when update is available, apply on next restart"
      - "Implement crash detection: if sidecar exits unexpectedly, send system notification"
      - "Implement auto-restart: restart crashed sidecar up to 3 times with 5s backoff"
      - "Send recovery notification when crashed service comes back"
      - "Add Enable/Disable Auto-Start toggle in tray menu"
    test_cases:
      - id: "p4-auto-start-creates"
        description: "Enabling auto-start creates platform-appropriate startup entry"
        type: "integration"
      - id: "p4-crash-restart"
        description: "Killing a sidecar process triggers restart and notification"
        type: "integration"
      - id: "p4-updater-check"
        description: "Auto-updater queries endpoint and reports current version as up-to-date"
        type: "integration"
  - id: p5
    name: "CI Pipeline (GitHub Actions + tauri-action)"
    tasks:
      - "Create .github/workflows/build-tray.yml with matrix: ubuntu-latest, macos-latest, windows-latest"
      - "Add bun install + bun build --compile step for each sidecar per target"
      - "Add tauri-action step to build + bundle installers"
      - "Upload artifacts: DMG (macOS), MSI (Windows), deb + AppImage (Linux)"
      - "Add release workflow: on tag push, create GitHub release with all platform artifacts"
      - "Generate update manifest JSON for tauri-plugin-updater on release"
      - "Cache Rust target/ and Bun binary compilation between runs"
    test_cases:
      - id: "p5-ci-builds"
        description: "GitHub Actions workflow completes on all three platforms"
        type: "smoke"
      - id: "p5-artifacts-exist"
        description: "Build artifacts include DMG, MSI, deb for respective platforms"
        type: "smoke"
  - id: p6
    name: "Cross-Platform Testing + Installer Polish"
    tasks:
      - "Test DMG install on macOS: mount, drag to Applications, launch, verify tray + sidecars"
      - "Test MSI install on Windows: run installer, verify Start Menu entry, launch, verify tray"
      - "Test deb install on Ubuntu: dpkg -i, verify desktop entry, launch, verify tray"
      - "Test headless mode on Ubuntu VPS: install binary, run --headless, curl /status"
      - "Verify auto-start works on each platform after install"
      - "Verify uninstall cleans up auto-start entries on each platform"
      - "Fix platform-specific issues discovered during testing"
      - "Update README with install instructions per platform"
    test_cases:
      - id: "p6-macos-install"
        description: "DMG install + launch produces working tray app with healthy sidecars"
        type: "smoke"
      - id: "p6-windows-install"
        description: "MSI install + launch produces working tray app with healthy sidecars"
        type: "smoke"
      - id: "p6-linux-install"
        description: "deb install + launch produces working tray app with healthy sidecars"
        type: "smoke"
      - id: "p6-headless-vps"
        description: "Headless binary on VPS starts both services, /status returns healthy"
        type: "smoke"
---

# Unified Tray App and Packaging

> GitHub Issue: [#15](https://github.com/codevibesmatter/duraclaw/issues/15)

## Overview

Duraclaw runs two long-lived Bun services on the user's machine: **cc-gateway** (Claude Agent SDK WebSocket server, port 9877) and **mdsync** (markdown sync engine, spec 0008). Today, cc-gateway is Linux-only via a manually-installed systemd unit (`packages/cc-gateway/systemd/duraclaw-cc-gateway.service`). mdsync does not exist yet. There is no unified way to install, start, monitor, or update these services, and no cross-platform support (macOS, Windows).

This spec delivers a **Tauri v2 system tray application** that bundles both services as compiled Bun sidecar binaries, provides a native tray icon with aggregate health status, and produces platform-specific installers (DMG, MSI, deb). A `--headless` mode supports VPS deployments where no display is available.

**Audience:** Developers and teams using Duraclaw to orchestrate Claude Code sessions across machines. Desktop users get a native tray experience; VPS operators get a single supervisor binary with HTTP status.

**Why now:** The mdsync service (spec 0008) is being built, doubling the number of local daemons. Without unified packaging, users must manually manage two systemd units (Linux-only), with no macOS/Windows path. The tray app completes the local install story.

---

## Feature Behaviors

### B1: Tray Icon with Aggregate Status

**Core:**
- **ID:** tray-icon-aggregate-status
- **Trigger:** Tray app starts, and periodically every 5 seconds thereafter
- **Expected:** System tray displays a Duraclaw icon. The icon color reflects aggregate service health: green when all managed services report healthy, yellow when at least one service is degraded or unreachable, red when all services are down, grey when all services are intentionally stopped.
- **Verify:** Start the tray app with both sidecars healthy. Icon is green. Kill one sidecar process. Within 10 seconds, icon turns yellow. Kill the other. Icon turns red.
- **Source:** `apps/duraclaw-tray/src-tauri/src/tray.rs` (new file)

#### UI Layer

Tray icon rendered via Tauri's `TrayIconBuilder`. Four icon assets stored at `apps/duraclaw-tray/src-tauri/icons/tray-green.png`, `tray-yellow.png`, `tray-red.png`, `tray-grey.png`. Tooltip text shows "Duraclaw - All services running" / "Duraclaw - Degraded" / "Duraclaw - All services stopped".

#### API Layer

N/A (local process, no external API for the icon itself).

#### Data Layer

In-memory `ServiceStatus` struct per service: `{ name: String, healthy: bool, last_check: Instant, details: Option<HealthResponse> }`.

---

### B2: Tray Menu with Per-Service Status Lines

**Core:**
- **ID:** tray-menu-service-status
- **Trigger:** User clicks the tray icon (or right-clicks on platforms where that opens the menu)
- **Expected:** A native context menu appears with the following structure: a "Duraclaw" header (disabled label), a separator, a status line per service showing a colored circle indicator and service name with status text (e.g., "Gateway -- Running (3 sessions)", "mdsync -- Synced (12 files)"), a separator, "Start All" and "Stop All" action items, "Open Config" action item, a separator, and "Quit".
- **Verify:** Open the tray menu. Confirm both service status lines are present with current state. Stop one service via kill. Reopen menu. That service line shows "Stopped".
- **Source:** `apps/duraclaw-tray/src-tauri/src/tray.rs` (new file)

#### UI Layer

Menu built with Tauri's `MenuBuilder` and `MenuItemBuilder`. Status lines are disabled menu items (not clickable) that update their text on each health poll. The circle indicator is a Unicode character: green circle (U+1F7E2), yellow circle (U+1F7E1), red circle (U+1F534), white circle (U+26AA) for stopped.

#### API Layer

N/A (native OS menu).

#### Data Layer

N/A (reads from in-memory ServiceStatus).

---

### B3: Start All / Stop All Actions

**Core:**
- **ID:** start-stop-all
- **Trigger:** User clicks "Start All" or "Stop All" in the tray menu
- **Expected:** "Start All" spawns any sidecars that are not currently running. "Stop All" sends SIGTERM (Unix) or terminates the process (Windows) to all running sidecars. Menu items are contextually enabled: "Start All" is disabled when all services are running, "Stop All" is disabled when no services are running.
- **Verify:** Click "Stop All". Both services stop (health check fails). Tray icon turns red. Click "Start All". Both services start (health check succeeds within 10s). Tray icon turns green.
- **Source:** `apps/duraclaw-tray/src-tauri/src/sidecar.rs` (new file)

#### UI Layer

Menu items toggle enabled/disabled state based on aggregate running status.

#### API Layer

N/A.

#### Data Layer

N/A (sidecar process handles stored in Rust `HashMap<String, Child>`).

---

### B4: Service Health Polling

**Core:**
- **ID:** health-polling
- **Trigger:** Timer fires every 5 seconds (configurable via `tray.poll_interval_ms` in `duraclaw.yaml`)
- **Expected:** For each managed service, issue `GET http://127.0.0.1:{port}/health` with a 3-second timeout. Parse the JSON response to extract status, uptime, and service-specific metadata (session count for gateway, file count for mdsync). On HTTP error or timeout, mark the service as unhealthy. Emit a Tauri custom event `health-update` with the full status map so the frontend (if a webview is later added) can react.
- **Verify:** Start both sidecars. Observe Rust logs showing health poll responses every 5 seconds. Stop one sidecar. Observe the next poll marks it unhealthy.
- **Source:** `apps/duraclaw-tray/src-tauri/src/health.rs` (new file), `packages/cc-gateway/src/server.ts:46` (existing `/health` endpoint)

#### UI Layer

N/A (health polling is backend; UI effects are via B1 and B2).

#### API Layer

Consumes existing endpoint:
- `GET http://127.0.0.1:9877/health` -- cc-gateway, returns `{ status: "ok", version: "0.1.0", uptime_ms: number }`
- `GET http://127.0.0.1:{mdsync_port}/health` -- mdsync (to be implemented in spec 0008), returns `{ status: "ok", syncing: number, errors: number }`

#### Data Layer

`HealthResponse` Rust struct deserialized from JSON. Stored in `Arc<Mutex<HashMap<String, ServiceStatus>>>` shared between the health poller thread and the tray menu updater.

---

### B5: Sidecar Lifecycle Management

**Core:**
- **ID:** sidecar-lifecycle
- **Trigger:** App startup, Start All action, or auto-restart after crash
- **Expected:** Each service is defined in `duraclaw.yaml` with a name and port. On startup, the Rust supervisor spawns each sidecar using `app.shell().sidecar("cc-gateway")` (Tauri sidecar API). The sidecar binary is resolved from `src-tauri/binaries/` with the appropriate target-triple suffix. Stdout and stderr from sidecars are captured and logged. On app quit (or "Stop All"), all sidecar processes receive SIGTERM and the supervisor waits up to 5 seconds before SIGKILL.
- **Verify:** Start the tray app. Check `ps aux | grep cc-gateway` confirms the sidecar process is running. Quit the tray app. Confirm the sidecar process is gone.
- **Source:** `apps/duraclaw-tray/src-tauri/src/sidecar.rs` (new file)

#### UI Layer

N/A (process management is backend).

#### API Layer

N/A.

#### Data Layer

Sidecar process handles (`tauri_plugin_shell::process::CommandChild`) stored in a Rust `HashMap<String, CommandChild>` guarded by `Mutex`. Environment variables passed to sidecars are read from the config's `env_file` path.

---

### B6: Hybrid Supervision (Attach to Existing Services)

**Core:**
- **ID:** hybrid-supervision
- **Trigger:** App startup, before spawning sidecars
- **Expected:** Before spawning a sidecar, the supervisor checks if the service is already running by hitting `GET /health` on the configured port. If a healthy response is received, the supervisor "attaches" to the existing process (marks it as externally managed, skips spawn, monitors health). The tray icon still reflects aggregate health. When the tray app quits, externally-managed services are left running (not killed). If an externally-managed service later goes down, the supervisor spawns its own sidecar to replace it.
- **Verify:** Start cc-gateway manually (`bun run packages/cc-gateway/src/server.ts`). Then start the tray app. Tray shows gateway as healthy (green). Quit the tray app. Gateway is still running (not killed). Start the tray app again. Kill the manual gateway. Tray detects it is down and spawns its own sidecar.
- **Source:** `apps/duraclaw-tray/src-tauri/src/sidecar.rs` (new file)

#### UI Layer

No visual distinction between self-managed and externally-managed services in the tray menu.

#### API Layer

Consumes `GET /health` on each service's configured port during startup probe.

#### Data Layer

`ServiceEntry` Rust struct includes a `managed: bool` field. When `managed` is false, the supervisor does not kill the process on quit.

---

### B7: Headless Mode

**Core:**
- **ID:** headless-mode
- **Trigger:** Binary invoked with `--headless` flag, or `DISPLAY`/`WAYLAND_DISPLAY` environment variables are unset on Linux
- **Expected:** The `main()` function branches before any Tauri initialization: if `--headless` is passed or `DISPLAY`/`WAYLAND_DISPLAY` are unset on Linux, the binary must NOT call `tauri::Builder` at all (Tauri's `Builder::run()` requires a display server on Linux and will panic without one). Instead, it runs a standalone tokio-based supervisor that manages sidecars via `tokio::process::Command` (not Tauri's shell API). The sidecar, health, and config modules must be usable without a Tauri `AppHandle`. An HTTP server starts on a configurable port (default 9870, set via `tray.headless_port` in config or `--port` flag) serving a `GET /status` endpoint that returns JSON: `{ services: [{ name, status, healthy, uptime_ms, port }], version, uptime_ms }`. The process runs as a foreground daemon suitable for systemd or launchd management. Passing `--status` instead queries the headless endpoint and prints a formatted table to stdout.
- **Verify:** Run `./duraclaw-tray --headless` on a VPS with no DISPLAY set. Confirm no tray errors. Run `curl http://127.0.0.1:9870/status` and confirm JSON response with service health. Run `./duraclaw-tray --status` and confirm table output.
- **Source:** `apps/duraclaw-tray/src-tauri/src/main.rs` (new file)

#### UI Layer

N/A (no GUI in headless mode). `--status` prints an ASCII table to stdout.

#### API Layer

`GET http://127.0.0.1:9870/status`

Response (200):
```json
{
  "services": [
    { "name": "cc-gateway", "status": "running", "healthy": true, "uptime_ms": 3600000, "port": 9877 },
    { "name": "mdsync", "status": "running", "healthy": true, "uptime_ms": 3600000, "port": 9878 }
  ],
  "version": "0.1.0",
  "uptime_ms": 3600000
}
```

#### Data Layer

Same in-memory `ServiceStatus` map as the tray mode. No persistent storage.

---

### B8: Unified Config

**Core:**
- **ID:** unified-config
- **Trigger:** App startup (tray or headless mode)
- **Expected:** The application reads `duraclaw.yaml` from a platform-specific config directory: `~/.config/duraclaw/duraclaw.yaml` (Linux), `~/Library/Application Support/duraclaw/duraclaw.yaml` (macOS), `%APPDATA%\duraclaw\duraclaw.yaml` (Windows). If the file does not exist, a default config is written. The config is parsed with `serde_yaml` in Rust. Validation errors are logged and cause a fallback to defaults (the app still starts). Config changes require an app restart to take effect (no hot-reload in v1).
- **Verify:** Delete `duraclaw.yaml`. Start the app. Confirm a default config file was created. Edit the config to change `gateway.port` to 9999. Restart the app. Confirm the health poller targets port 9999.
- **Source:** `apps/duraclaw-tray/src-tauri/src/config.rs` (new file)

#### UI Layer

"Open Config" tray menu item opens the YAML file in the system default editor via `open` (macOS), `xdg-open` (Linux), or `start` (Windows).

#### API Layer

N/A.

#### Data Layer

Config file structure:
```yaml
# duraclaw.yaml
gateway:
  port: 9877
  env_file: /data/projects/duraclaw/.env
  binary: cc-gateway              # sidecar binary name (resolved with target-triple)

mdsync:
  port: 9878
  watch_paths:
    - /data/projects/duraclaw/docs
    - /data/projects/duraclaw/planning
  binary: mdsync

tray:
  poll_interval_ms: 5000
  headless_port: 9870
  auto_start: true
  notifications: true
```

Rust struct: `DuraclawConfig` with nested `GatewayConfig`, `MdsyncConfig`, `TrayConfig`. All fields have defaults via `#[serde(default)]`.

---

### B9: Auto-Start on Login

**Core:**
- **ID:** auto-start-login
- **Trigger:** User enables "Auto-Start" via the tray menu toggle, or `tray.auto_start: true` in config
- **Expected:** The application registers itself to start on user login using the platform-native mechanism. On macOS: creates a launchd plist at `~/Library/LaunchAgents/com.duraclaw.tray.plist` with `RunAtLoad: true`. On Linux: creates a systemd user unit at `~/.config/systemd/user/duraclaw-tray.service` and runs `systemctl --user enable duraclaw-tray`. On Windows: creates a registry key at `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` pointing to the executable. Disabling auto-start removes the respective entry.
- **Verify:** Enable auto-start. Log out and log back in. Confirm the tray app is running without manual launch. Disable auto-start. Log out and back in. Confirm the tray app is not running.
- **Source:** `apps/duraclaw-tray/src-tauri/src/autostart.rs` (new file)

#### UI Layer

Tray menu item "Auto-Start" with a checkmark indicator. Checked when auto-start is enabled, unchecked when disabled. Clicking toggles the state.

#### API Layer

N/A.

#### Data Layer

`tray.auto_start` boolean in `duraclaw.yaml` is updated when toggled from the menu.

---

### B10: Auto-Update

**Core:**
- **ID:** auto-update
- **Trigger:** App startup, and every 6 hours thereafter
- **Expected:** The app checks for updates via `tauri-plugin-updater`. The update manifest is hosted as a JSON file on the GitHub release (generated by CI). If a newer version is available, a system notification informs the user. The update is downloaded in the background and applied on next restart. Sidecar binaries are bundled inside the Tauri update package, so they are updated atomically with the tray app. In headless mode, the update check still runs and logs a message, but does not show a notification. The `--status` output includes the current version and whether an update is available.
- **Verify:** Set the app version to 0.0.1 in tauri.conf.json. Point the update URL to a test manifest advertising 0.1.0. Start the app. Confirm a system notification appears indicating an update is available. Restart the app. Confirm it updates to 0.1.0.
- **Source:** `apps/duraclaw-tray/src-tauri/src/updater.rs` (new file), `apps/duraclaw-tray/src-tauri/tauri.conf.json`

#### UI Layer

System notification via Tauri's notification API: "Duraclaw Update Available - Version X.Y.Z is ready. Restart to apply."

#### API Layer

Tauri updater fetches: `GET https://github.com/codevibesmatter/duraclaw/releases/latest/download/update-manifest.json`

Manifest format (Tauri convention):
```json
{
  "version": "0.2.0",
  "notes": "Bug fixes and performance improvements",
  "pub_date": "2026-04-10T00:00:00Z",
  "platforms": {
    "darwin-aarch64": { "url": "https://...Duraclaw.app.tar.gz", "signature": "..." },
    "linux-x86_64": { "url": "https://...duraclaw-tray_0.2.0_amd64.AppImage.tar.gz", "signature": "..." },
    "windows-x86_64": { "url": "https://...Duraclaw_0.2.0_x64-setup.nsis.zip", "signature": "..." }
  }
}
```

#### Data Layer

N/A (update state is transient).

---

### B11: System Notifications (Crash and Recovery)

**Core:**
- **ID:** crash-recovery-notifications
- **Trigger:** A managed sidecar process exits unexpectedly (exit code != 0 or signal death)
- **Expected:** The supervisor detects the sidecar exit via the process handle. It sends a system notification: "Duraclaw: {service} crashed - Restarting...". It restarts the sidecar with a 5-second delay, up to 3 consecutive restart attempts. If all 3 attempts fail, it sends a final notification: "Duraclaw: {service} failed to restart - Check logs" and marks the service as permanently down until the user manually triggers "Start All". On successful restart, it sends: "Duraclaw: {service} recovered". In headless mode, these events are logged to stdout/stderr instead of system notifications.
- **Verify:** Start the tray app with both sidecars running. Kill the cc-gateway process (`kill -9 <pid>`). Observe a crash notification. Observe the service restarting within 5 seconds. Observe a recovery notification.
- **Source:** `apps/duraclaw-tray/src-tauri/src/sidecar.rs` (new file)

#### UI Layer

System notifications via `tauri-plugin-notification`. Notification title: "Duraclaw". Body varies by event type.

#### API Layer

N/A.

#### Data Layer

Per-service restart counter: `restart_count: u32` in `ServiceEntry`, reset to 0 on successful health check after restart.

---

### B12: Cross-Platform Installer Output

**Core:**
- **ID:** cross-platform-installers
- **Trigger:** CI pipeline runs (on tag push or manual workflow dispatch)
- **Expected:** The CI pipeline produces platform-specific installers: DMG for macOS (universal binary or arm64), MSI/NSIS for Windows (x64), deb and AppImage for Linux (x64). Each installer bundles the Tauri shell (~5 MB) plus Bun-compiled sidecar binaries (~50-80 MB each, two services). Total install size is approximately 110-170 MB. Installers register the app in the system's application list. Uninstall removes the app binary, sidecar binaries, and auto-start entries (but preserves `duraclaw.yaml`).
- **Verify:** Download the DMG artifact from a CI run. Mount it on macOS. Drag Duraclaw.app to Applications. Launch it. Confirm tray icon appears and sidecars start. Repeat equivalent steps with MSI on Windows and deb on Linux.
- **Source:** `apps/duraclaw-tray/src-tauri/tauri.conf.json`, `.github/workflows/build-tray.yml` (new file)

#### UI Layer

macOS DMG shows a drag-to-Applications background image. Windows MSI/NSIS shows a standard install wizard. Linux deb installs silently via `dpkg -i`.

#### API Layer

N/A.

#### Data Layer

N/A.

---

## Non-Goals

Explicitly out of scope for this feature:

- **Rich dashboard or webview window** -- the tray menu is the only UI surface. A status webview is a future enhancement.
- **Replacing systemd on VPS** -- headless mode coexists with manual systemd units. Users who prefer raw systemd can continue using `packages/cc-gateway/systemd/duraclaw-cc-gateway.service`.
- **Mobile platforms** -- iOS and Android are not targeted.
- **Plugin or extension system** -- the tray app manages a fixed set of known services.
- **Bundling the orchestrator** -- the Cloudflare Workers orchestrator (`apps/orchestrator/`) is deployed separately and is not part of the local install.
- **Config hot-reload** -- changes to `duraclaw.yaml` require restarting the tray app. File watching for config is a future enhancement.
- **Custom sidecar binaries** -- users cannot add arbitrary services to the tray. Only cc-gateway and mdsync are managed.

---

## Open Questions

- **Update signing key strategy** -- what key pair should be used for tauri-plugin-updater? A project-owned key needs secure storage and rotation plan.
- **Log file location** -- where are sidecar logs written in tray mode (not headless/journald)? Options include platform log directories, a `~/.config/duraclaw/logs/` folder, or only in-memory with tray log viewer.
- **Port conflict detection** -- how to distinguish "port in use by another process" from "service not running"? A failed health check could mean either case, and spawning a sidecar on a taken port will fail silently.

---

## Implementation Phases

See YAML frontmatter `phases:` above. Each phase should be 2-6 hours of focused work.

**P1: Scaffold Tauri v2 App + Tray Icon + Single Sidecar (cc-gateway only)**
Establishes the project structure, Tauri tray-only app, and proves the sidecar pattern works end-to-end with one service. Delivers B1 (partial -- single service), B4 (single service), B5 (single service).

**P2: Add mdsync Sidecar + Health Polling + Unified Config + Hybrid Supervision**
Adds the second sidecar, the config system, hybrid attach-or-spawn supervision, and completes the tray menu with per-service status. Delivers B1 (complete), B2, B3, B4 (complete), B6, B8.

**P3: Headless Mode + systemd Integration**
Adds the `--headless` flag, the HTTP status endpoint, display auto-detection, and the headless install script. Delivers B7.

**P4: Auto-Start, Auto-Update, Notifications**
Adds platform auto-start registration, the Tauri updater plugin, and crash/recovery notifications. Delivers B9, B10, B11.

**P5: CI Pipeline (GitHub Actions + tauri-action)**
Creates the cross-platform build pipeline that produces installers and update manifests. Delivers B12.

**P6: Cross-Platform Testing + Installer Polish**
Manual and automated testing of installers on all three platforms, fixing platform-specific issues. Hardens all behaviors.

---

## Verification Strategy

### Test Infrastructure

Rust unit tests via `cargo test` in `apps/duraclaw-tray/src-tauri/`. Integration tests use a mock HTTP server (e.g., `wiremock` crate) to simulate sidecar health endpoints. No existing test config -- created in P1.

For sidecar integration testing, a minimal Bun HTTP server script (`apps/duraclaw-tray/test/mock-sidecar.ts`) serves as a fake `/health` endpoint to avoid requiring real cc-gateway or mdsync builds during development.

### Build Verification

```bash
# Build sidecar binaries
cd /data/projects/duraclaw && bun build --compile packages/cc-gateway/src/server.ts --outfile apps/duraclaw-tray/src-tauri/binaries/cc-gateway

# Build Tauri app (dev mode)
cd /data/projects/duraclaw/apps/duraclaw-tray && cargo tauri dev

# Build Tauri app (release)
cd /data/projects/duraclaw/apps/duraclaw-tray && cargo tauri build

# Run Rust tests
cd /data/projects/duraclaw/apps/duraclaw-tray/src-tauri && cargo test
```

---

## Verification Plan

### VP1: Tray App Launches with Healthy Sidecar
Steps:
1. `cd /data/projects/duraclaw && bun build --compile packages/cc-gateway/src/server.ts --outfile apps/duraclaw-tray/src-tauri/binaries/cc-gateway-$(rustc -vV | grep host | awk '{print $2}')`
   Expected: Binary created at the target path, ~50-80 MB
2. `cd /data/projects/duraclaw/apps/duraclaw-tray && cargo tauri dev`
   Expected: Tray icon appears in system tray, colored green
3. `curl -s http://127.0.0.1:9877/health | jq .status`
   Expected: Returns `"ok"` -- cc-gateway sidecar is running

### VP2: Tray Reflects Service Failure
Steps:
1. `pgrep -f 'cc-gateway' | xargs kill -9`
   Expected: Tray icon changes to red/yellow within 10 seconds
2. `for i in $(seq 1 10); do curl -s http://127.0.0.1:9877/health && break; sleep 1; done`
   Expected: Tray icon returns to green, cc-gateway process is running again
3. `curl -s http://127.0.0.1:9877/health | jq .status`
   Expected: Returns `"ok"`

### VP3: Headless Mode Status Endpoint
Steps:
1. `cd /data/projects/duraclaw/apps/duraclaw-tray && cargo tauri build`
   Expected: Release binary produced
2. `./src-tauri/target/release/duraclaw-tray --headless &`
   Expected: Process starts without tray errors, logs health poll results to stdout
3. `curl -s http://127.0.0.1:9870/status | jq .services`
   Expected: JSON array with cc-gateway and mdsync entries, each with `healthy: true`
4. `./src-tauri/target/release/duraclaw-tray --status`
   Expected: Formatted table showing service names, ports, and status

### VP4: Config Creates Default and Applies Port Override
Steps:
1. `rm -f ~/.config/duraclaw/duraclaw.yaml`
   Expected: File removed
2. Start the tray app (or headless mode)
   Expected: `~/.config/duraclaw/duraclaw.yaml` is created with default values
3. Edit `~/.config/duraclaw/duraclaw.yaml`, set `gateway.port: 9999`
4. Restart the tray app
5. `curl -s http://127.0.0.1:9999/health | jq .status`
   Expected: Returns `"ok"` -- gateway was spawned on the overridden port

### VP5: Hybrid Supervision Attaches to Existing Service
Steps:
1. `cd /data/projects/duraclaw && bun run packages/cc-gateway/src/server.ts &`
   Expected: cc-gateway starts manually on port 9877
2. Start the tray app
   Expected: Tray shows gateway as healthy (green). No second cc-gateway process spawned.
3. Quit the tray app
4. `curl -s http://127.0.0.1:9877/health | jq .status`
   Expected: Returns `"ok"` -- the manually started gateway is still running

### VP6: Cross-Platform Build Artifacts
Steps:
1. `cd /data/projects/duraclaw/apps/duraclaw-tray && cargo tauri build`
   Expected: Platform-specific installer appears in `src-tauri/target/release/bundle/` (deb on Linux, dmg on macOS, msi on Windows)
2. `ls -la src-tauri/target/release/bundle/deb/*.deb` (Linux example)
   Expected: `.deb` file exists, size > 50 MB (includes sidecar binaries)

---

## Implementation Hints

### Dependencies

```bash
# Initialize Tauri v2 project
cargo install create-tauri-app
cd /data/projects/duraclaw/apps && cargo create-tauri-app duraclaw-tray --template react-ts

# Tauri plugins (add to src-tauri/Cargo.toml)
# tauri-plugin-shell (sidecar management)
# tauri-plugin-notification (crash/recovery alerts)
# tauri-plugin-updater (auto-update)

# Rust crates for src-tauri/Cargo.toml
# serde_yaml = "0.9" (config parsing)
# reqwest = { version = "0.12", features = ["json"] } (health polling)
# tokio = { version = "1", features = ["full"] } (async runtime)
# wiremock = "0.6" (test mock server, dev-dependency)
```

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `tauri::tray` | `TrayIconBuilder, TrayIconEvent` | Creating and updating system tray icon |
| `tauri::menu` | `MenuBuilder, MenuItemBuilder, Separator` | Building the tray context menu |
| `tauri_plugin_shell` | `ShellExt` | `app.shell().sidecar("cc-gateway")` to spawn sidecars |
| `tauri_plugin_notification` | `NotificationExt` | Sending system notifications for crash/recovery |
| `tauri_plugin_updater` | `UpdaterExt` | Checking for and applying updates |
| `serde_yaml` | `serde_yaml::from_str` | Parsing duraclaw.yaml config |
| `reqwest` | `reqwest::Client` | HTTP GET for health polling |

### Code Patterns

**Tauri tray-only app (tauri.conf.json):**
```json
{
  "app": {
    "windows": [],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "externalBin": ["binaries/cc-gateway", "binaries/mdsync"]
  },
  "plugins": {
    "updater": {
      "endpoints": ["https://github.com/codevibesmatter/duraclaw/releases/latest/download/update-manifest.json"],
      "pubkey": "..."
    },
    "shell": {
      "sidecar": true
    }
  }
}
```

**Spawning a sidecar (Rust):**
```rust
use tauri_plugin_shell::ShellExt;

fn spawn_sidecar(app: &tauri::AppHandle, name: &str, args: &[&str]) -> Result<CommandChild, Error> {
    let (mut rx, child) = app.shell()
        .sidecar(name)?
        .args(args)
        .spawn()?;

    // Log sidecar output in background
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => log::info!("[{}] {}", name, String::from_utf8_lossy(&line)),
                CommandEvent::Stderr(line) => log::warn!("[{}] {}", name, String::from_utf8_lossy(&line)),
                CommandEvent::Terminated(status) => {
                    log::error!("[{}] exited with {:?}", name, status);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(child)
}
```

**Health polling loop (Rust):**
```rust
async fn poll_health(
    client: &reqwest::Client,
    services: Arc<Mutex<HashMap<String, ServiceStatus>>>,
    interval: Duration,
) {
    loop {
        let mut statuses = services.lock().await;
        for (name, status) in statuses.iter_mut() {
            let url = format!("http://127.0.0.1:{}/health", status.port);
            match client.get(&url).timeout(Duration::from_secs(3)).send().await {
                Ok(resp) if resp.status().is_success() => {
                    status.healthy = true;
                    status.last_check = Instant::now();
                    status.details = resp.json().await.ok();
                }
                _ => {
                    status.healthy = false;
                    status.last_check = Instant::now();
                    status.details = None;
                }
            }
        }
        drop(statuses);
        tokio::time::sleep(interval).await;
    }
}
```

**Config struct (Rust):**
```rust
#[derive(Deserialize, Serialize, Default)]
struct DuraclawConfig {
    #[serde(default)]
    gateway: GatewayConfig,
    #[serde(default)]
    mdsync: MdsyncConfig,
    #[serde(default)]
    tray: TrayConfig,
}

#[derive(Deserialize, Serialize)]
struct GatewayConfig {
    #[serde(default = "default_gateway_port")]
    port: u16,
    env_file: Option<String>,
    #[serde(default = "default_gateway_binary")]
    binary: String,
}

fn default_gateway_port() -> u16 { 9877 }
fn default_gateway_binary() -> String { "cc-gateway".to_string() }
```

**Bun compile for sidecar (build script):**
```bash
#!/usr/bin/env bash
set -euo pipefail
TARGET_TRIPLE=$(rustc -vV | grep host | awk '{print $2}')
cd "$(dirname "$0")/../.."

bun build --compile packages/cc-gateway/src/server.ts \
  --outfile "apps/duraclaw-tray/src-tauri/binaries/cc-gateway-${TARGET_TRIPLE}"

bun build --compile packages/mdsync/src/server.ts \
  --outfile "apps/duraclaw-tray/src-tauri/binaries/mdsync-${TARGET_TRIPLE}"
```

### Gotchas

- Tauri sidecar binaries must have a target-triple suffix (e.g., `cc-gateway-x86_64-unknown-linux-gnu`). The `externalBin` config in tauri.conf.json uses the base name without the suffix -- Tauri appends the triple at runtime.
- Bun-compiled binaries are large (~50-80 MB each) because they embed the Bun runtime. This makes the total installer ~160 MB. Consider this acceptable for a desktop app (comparable to Electron apps).
- On macOS, the tray app must have an Info.plist entry `LSUIElement: true` to run as an agent (no dock icon). Tauri handles this when `windows` is empty.
- On Windows, NSIS installer is recommended over MSI for better UX (progress bar, custom install path). Configure via `tauri.conf.json` bundle targets.
- The `--headless` flag must be parsed before Tauri initializes its event loop. Use `std::env::args()` in `main()` before calling `tauri::Builder`.
- Headless mode must NOT call `tauri::Builder` at all. On Linux, `Builder::run()` requires a display server and will panic without one. The `main()` function must branch into a standalone tokio supervisor that uses `tokio::process::Command` for sidecar management instead of Tauri's shell plugin. The sidecar, health, and config modules must be designed as plain Rust with no dependency on `AppHandle`, so both the Tauri path and the headless path can use them.
- Cross-compiling Bun binaries (e.g., building Linux binary on macOS) works via `bun build --compile --target=bun-linux-x64` but Windows cross-compile cannot set icons. CI builds on native runners avoid this limitation.
- The existing systemd unit at `packages/cc-gateway/systemd/duraclaw-cc-gateway.service` runs `bun run packages/cc-gateway/src/server.ts` from source. The headless tray mode runs the compiled binary instead. Both approaches work; the headless install script should document the difference.
- Health endpoint response shapes will vary between services. The Rust health poller should handle unknown fields gracefully via `serde_json::Value` fallback for the details field.

### Reference Docs

- [Tauri v2 System Tray](https://v2.tauri.app/learn/system-tray/) -- tray icon creation, menu building, event handling
- [Tauri v2 Sidecar](https://v2.tauri.app/develop/sidecar/) -- bundling and spawning external binaries
- [Tauri v2 Distribution](https://v2.tauri.app/distribute/) -- bundler configuration, installer types, signing
- [Tauri Plugin Updater](https://v2.tauri.app/plugin/updater/) -- auto-update configuration and manifest format
- [Tauri Plugin Shell](https://v2.tauri.app/plugin/shell/) -- sidecar spawn API, process management
- [Tauri Plugin Notification](https://v2.tauri.app/plugin/notification/) -- system notification API
- [Bun Single-File Executable](https://bun.com/docs/bundler/executables) -- `bun build --compile` usage and cross-compilation
- [Tray-Only Tauri App Guide](https://dev.to/daanchuk/how-to-create-a-tray-only-tauri-app-2ej9) -- practical walkthrough of empty windows config
