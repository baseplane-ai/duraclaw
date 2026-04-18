---
date: 2026-04-18
topic: Ionic (Capacitor) mobile and Electron desktop build targets
status: complete
github_issue: null
related:
  - planning/research/2026-04-10-unified-packaging-tray-app.md
  - planning/research/2026-04-12-phase4-push-pwa.md
  - planning/specs/roadmap-v2-full-vision.md (Phase 0.1c, Phase 8.3)
---

# Research: Ionic (Capacitor) Mobile and Electron Desktop Build Targets

## Context

Duraclaw's orchestrator UI is a React 19 SPA served by a Cloudflare Worker.
The roadmap already commits to a Capacitor native shell in Phase 8.3 as a
follow-up to the PWA work and to the Phase 0.1c "commit to SPA" step. The
user asked to evaluate **Ionic mobile** (i.e. Capacitor, with or without
the Ionic component library) and **Electron desktop** as parallel build
targets for that same React codebase.

Key prior decisions this research interacts with:

- **Tauri v2 tray app** is already the plan for packaging `cc-gateway` +
  `mdsync` on the VPS operator's desktop (see
  `2026-04-10-unified-packaging-tray-app.md`). That's a supervisory shell,
  not the product UI — but it's the same decision surface as "use Tauri
  for a full desktop app".
- **Web Push + PWA** is Phase 4 in the roadmap and partially shipped
  (`VitePWA({strategies:'injectManifest'})` is wired up in
  `apps/orchestrator/vite.config.ts` and there's a `sw.ts` at the UI
  root). A mobile-installable PWA is already the default distribution
  channel for mobile.
- **Phase 0.1c (SPA commit)** was scheduled but — on inspection —
  `entry-client.tsx` is already a plain `ReactDOM.createRoot` mount and
  `router.tsx` uses `@tanstack/react-router` with no `createServerFn`
  anywhere in `apps/orchestrator/src/`. The app is already SPA-shaped.
  The CF Worker is effectively an API/WS/DO host with a static asset
  bundle attached. Both Capacitor and Electron benefit from this: the
  client build is already a portable SPA.

Classification: **library/tech evaluation + feasibility study**, with
some brainstorming on which combinations are worth pursuing at all.

## TL;DR

1. **Capacitor 7** (with or without Ionic React UI components) is the
   right mobile target and the roadmap already commits to it. The real
   questions are not *whether* but *which plugins, which auth flow, and
   how early*. Two blockers deserve an upstream fix in the Worker
   **before** the Capacitor shell arrives: (a) Better Auth cookies need
   a bearer-token fallback for WKWebView, (b) CORS / WS-origin needs to
   accept `capacitor://localhost` and `https://localhost`.
2. **"Ionic the framework"** (the `@ionic/react` component library) is
   **not** recommended. We already have Radix + Tailwind + our own
   `@duraclaw/ai-elements` design system. Mixing Ionic's opinionated
   iOS/Material-mode components in would double the component surface
   area. Use Capacitor bare with our existing components plus a few
   capacitor-community plugins.
3. **Electron is not the right desktop shell for us.** Tauri v2 is
   already being adopted for the tray supervisor, has a smaller binary
   (~3–8 MB vs ~150 MB), and can load the same `dist/client/` bundle as
   a full desktop app window. If we want a dedicated desktop build
   target, promote the Tauri tray to a "Duraclaw Desktop" app that
   optionally renders the full UI in a window and keeps its tray
   behaviours. Adopting Electron in addition to Tauri would give us
   two desktop-shell toolchains with overlapping scope — a tax we'd
   pay forever with no commensurate benefit.
4. **The PWA is the true third shell.** It's already wired; finishing
   Phase 4 gives us an installable app on every platform that supports
   PWAs (Chromium desktop, Android, iOS 16.4+). The native shells are
   supplements to plug PWA gaps (iOS push, OS-level share, background
   fetch, secure local file-system access), not replacements.

## The SPA precondition (already satisfied)

Both Capacitor and any desktop shell that bundles assets locally need a
purely static client build. Capacitor serves files from a local origin
(`capacitor://localhost` on iOS, `https://localhost` on Android, or a
custom `capacitor.config.ts` hostname). Electron/Tauri can load a local
`file://` or bundled-asset URL in-process.

The roadmap's Phase 0.1c ("drop TanStack Start, plain Vite 8 + TanStack
Router SPA") reads as future work, but the orchestrator source already
matches that shape:

- `apps/orchestrator/src/entry-client.tsx` — `ReactDOM.createRoot(...)`,
  awaits `dbReady` (OPFS persistence), mounts `<RouterProvider>`.
- `apps/orchestrator/src/router.tsx` — plain `createTanStackRouter({
  routeTree })`.
- `apps/orchestrator/src/api/` — API handlers are just Hono routes
  inside `src/server.ts`; not TanStack Start server functions.
- `grep createServerFn` across `apps/orchestrator/src/` → 0 matches.
- `wrangler.toml` → `[assets] binding = "ASSETS" directory =
  "./dist/client"` — the Worker already treats the client as a static
  asset bundle.

So there is no SSR work to undo before we can ship a Capacitor/Electron
build. The CF Worker's role cleanly separates into:

- **Static asset bundle** (`dist/client/`) — portable, can be embedded
  in Capacitor `ios/App/App/public/` or an Electron/Tauri `resources/`
  directory at build time.
- **API + WS + DO host** (the Worker itself) — stays hosted, called
  from any shell over HTTPS/WSS.

This is the shape both Ionic- and Electron-style research assumes below.

## Ionic / Capacitor mobile

### Terminology

"Ionic" can mean two separate things that get conflated:

- **Capacitor** — Ionic Inc.'s cross-platform native runtime. A thin
  native wrapper (WKWebView on iOS, WebView on Android) that hosts your
  web app, with a JS/Swift/Kotlin bridge to native plugins. Framework-
  agnostic; doesn't care whether the UI is React, Vue, Svelte, or plain
  HTML. **This is what we want.**
- **Ionic Framework** (`@ionic/react`) — a component library of iOS-
  and Material-mode styled widgets (IonButton, IonModal, IonTabs, etc.)
  plus routing helpers. Designed to make a PWA feel native. **This is
  optional** and in our case I recommend skipping it.

The roadmap Phase 8.3 says "Capacitor Native Shell" — Capacitor bare,
not Ionic Framework. I agree.

### Capacitor 7 state (as of 2025H2 / 2026Q1)

- Capacitor 7 is the current major line (released July 2025). It
  requires Android SDK 35 / Gradle 8.7+ / Java 21, and Xcode 16 / iOS
  15+. Matches where the Apple/Google platform floors are today.
- Cross-platform plugin API is stable. Official plugins cover the
  plumbing we need: Preferences, Filesystem, Network, StatusBar,
  Keyboard, SplashScreen, App (state + deep-link handling),
  PushNotifications, LocalNotifications, Haptics, Device.
- Community plugins add the rest: `@capacitor-community/sqlite`
  (for the roadmap Phase 8.1 local cache), `@capgo/inappbrowser`
  (OAuth flows that need a system browser tab), `@capacitor/barcode-
  scanner`, etc.
- Live reload in dev ("Capacitor dev server") points the WKWebView at
  `http://<laptop-ip>:<port>` so we can iterate against the portless
  dev stack without rebuilding the `.ipa`/`.apk`.
- Capacitor 7 supports the iOS Live Activities and ActivityKit APIs
  via official plugins — interesting as a Phase 9 "session status on
  your lock screen" path, but out of scope for the initial shell.

### What the shell looks like

```
apps/duraclaw-mobile/          # new app
  ios/                         # Xcode project (generated by cap add ios)
  android/                     # Gradle project (generated by cap add android)
  capacitor.config.ts          # points at ../orchestrator/dist/client
  package.json                 # depends on @duraclaw/orchestrator as a build input
  src/
    plugins-shim.ts            # conditional capacitor/web shims
    native-auth.ts             # bearer-token exchange for cookieless auth
```

Build flow:

1. `pnpm --filter @duraclaw/orchestrator build` produces `dist/client/`.
2. `capacitor.config.ts` sets `webDir: '../orchestrator/dist/client'`.
3. `npx cap sync` copies the build into `ios/App/App/public/` and
   `android/app/src/main/assets/public/` and updates plugin configs.
4. `npx cap run ios` / `npx cap run android` builds and launches.

No changes to the React source code for the basic path. The
interesting work is in integrating native capabilities.

### Auth is the real work

Better Auth today issues `__Secure-better-auth.session_token` cookies
from the Worker. Capacitor webviews run on a different origin
(`capacitor://localhost` on iOS, `https://localhost` on Android), so
every API call is cross-origin from the webview's perspective.

Two problems this creates:

1. **Cookies crossing origins.** Browsers treat the response cookie as
   third-party. iOS WKWebView under ITP will drop or partition it.
   Android Chromium is more permissive but still relies on
   `SameSite=None; Secure; Partitioned` cookie attributes.
2. **CORS preflight.** Every credentialed `fetch` will preflight; the
   Worker currently doesn't advertise `Access-Control-Allow-Origin` for
   `capacitor://localhost`.

The clean solution is to add a **bearer-token auth path** alongside the
cookie path:

- Login endpoint returns `{ token, userId, expiresAt }` in the body
  when called from a native shell (detect via a custom
  `X-Client-Platform: capacitor-ios` header we set).
- Native shell stores the token in `@capacitor/preferences` (which
  uses iOS Keychain and Android SharedPreferences — already encrypted
  at rest on modern OS versions).
- API client reads the token and sends `Authorization: Bearer <token>`
  on every request; the Worker checks the bearer header first and
  falls back to the session cookie otherwise.
- WebSocket dial passes the token as a query param (same as how the
  runner dials the DO today): `wss://.../agents/session-agent/<id>?
  token=<bearer>`.

Better Auth has first-class support for this via its `bearer` plugin
and per-client session adapters — not a rewrite, a plugin addition.

We should land this **before** the Capacitor shell even if it's not
strictly required by the web flow, because:

- It's the same pattern the session runner already uses (dial-back WSS
  with a token query param), so there's prior art in the codebase.
- It de-risks Phase 4 service worker work too (SW fetch events don't
  always get the cookie in every browser/version).

### Push: APNs/FCM swap, not Web Push

Web Push works on Android Chrome and iOS 16.4+ Safari under specific
PWA-installed conditions; it does **not** work in WKWebView (i.e. the
Capacitor iOS shell). The Capacitor solution is to use the
`@capacitor/push-notifications` plugin, which routes through APNs on
iOS and FCM on Android.

Subscription model changes minimally: the existing `push_subscriptions`
D1 table (see `2026-04-12-phase4-push-pwa.md`) already stores per-user
endpoints. Add a `platform` column (`'web' | 'ios' | 'android'`) and
route dispatch accordingly:

- `platform = 'web'` → `@pushforge/builder` with VAPID (existing path).
- `platform = 'ios' | 'android'` → dispatch to a Firebase Admin-
  compatible endpoint (the simplest path is FCM HTTP v1 for both iOS
  and Android, with APNs configured as an iOS dispatch channel inside
  Firebase Console — one fewer credential to manage than direct APNs).

This is an additive change. Nothing in the Web Push code has to move.

### WebSocket & Durable Objects

Nothing special. `partysocket` and the existing DO WS endpoints work
from any origin. The Worker's upgrade handler should just accept the
bearer token from query string when no cookie is present. The DO
doesn't care about origin — it already validates the `active_callback_
token` for the runner.

One subtle Android-WebView gotcha: the Android WebView occasionally
fails to upgrade `wss://` on flaky networks, and because `partysocket`
retries aggressively this can manifest as a connection storm. Worth a
one-line fix (exponential backoff with jitter, which `partysocket`
supports via config) rather than a design change.

### File-system access

One of the reasons users want a native shell is OS-level file access
(picking a project directory, dragging in a screenshot). Capacitor
gives us the pieces:

- `@capacitor/filesystem` — sandboxed document storage; good for
  session exports, attachment cache.
- `@capawesome/capacitor-file-picker` — OS file picker on both
  platforms. The selected `file://` URI is readable from JS.
- `@capacitor/share` — outbound share sheet (share a session link or
  export to other apps).

What Capacitor **cannot** do is read arbitrary project directories
under `/data/projects/` on a VPS — that's not the role of the mobile
shell. Project picking stays a remote operation against the agent-
gateway's HTTP browse endpoints. The mobile shell is a remote control,
not a local development environment.

### Ionic Framework (`@ionic/react`): skip it

Arguments for using `@ionic/react`:

- Pre-built iOS/Material-mode components (IonTabs, IonModal,
  IonRefresher) look platform-native out of the box.
- Platform-aware routing with gesture-based back swipe.

Arguments against:

- We already have Radix primitives + Tailwind + `@duraclaw/ai-elements`.
  Adding Ionic means two competing button styles, two modal
  implementations, two theme systems.
- Ionic's look is opinionated iOS/Material; Duraclaw's design system
  is neither. Theming Ionic components to match our palette is more
  work than building the two or three components (swipeable drawer,
  pull-to-refresh) we'd actually use from it.
- Ionic's React router integrates with `@ionic/react-router`, which
  is a wrapper around React Router; we use TanStack Router. Glue
  code exists but is a supported-path bet we don't need to make.

What we actually need from "Ionic" is a small handful of patterns:

- Swipeable sidebar drawer — we have `@use-gesture/react` already.
- Pull-to-refresh on session list — ~30 lines with `@use-gesture/
  react` + `@react-spring/web`, both already in dependencies.
- Bottom nav bar on mobile breakpoint — the roadmap Phase 0.3 spec
  already covers it as plain responsive React.
- Safe-area insets — pure CSS (`env(safe-area-inset-*)`) plus a
  `<meta name="viewport" content="viewport-fit=cover">` tag.

**Recommendation: Capacitor bare, not Ionic Framework.** Revisit only
if we find ourselves re-implementing three or more Ionic components
from scratch.

## Electron desktop

Electron is the question that actually deserves scrutiny, because —
unlike Capacitor — it isn't already committed in the roadmap and it
overlaps with work we've decided to do in Tauri.

### What Electron buys us

Things a desktop Electron shell would offer over the installable PWA:

- OS-native notifications with full action support on all three OSes
  (browsers vary; Safari desktop's Web Push is weak).
- A dock/tray icon the user can click to surface the app instantly
  without a browser tab.
- Access to OS file dialogs, local shell integration (open in Finder
  /Explorer/Files), local keychain for token storage.
- Protocol handler (`duraclaw://session/<id>`) that survives browser
  restarts and works from outside the browser.
- Cross-window state: multiple session windows visible as separate
  OS windows in the task switcher.
- Auto-update that doesn't depend on the browser visiting the site.

### What Electron costs

- **~130–160 MB per install** (Chromium + Node + V8 + ffmpeg binaries,
  even with `--pack`). Tauri equivalent: 3–8 MB shell + whatever we
  bundle.
- **RAM overhead** — an idle Electron window costs ~150–250 MB RAM;
  Tauri's OS webview (WebView2/WKWebView/WebKitGTK) costs ~50–80 MB.
- **Security surface** — Chromium patch cadence means the app is only
  as safe as the last Electron bump. Tauri delegates to the OS webview,
  which gets OS security updates.
- **Distribution toolchain** — `electron-builder` works, but signing,
  notarization, MSIX, and auto-update on three OSes is its own project.
  Tauri bundles DMG/MSI/NSIS/deb/rpm/AppImage out of the box via a
  single `tauri build`.
- **Duplication with Tauri plan** — the April 10 research already
  chose Tauri v2 for the tray + sidecar supervisor. Adding Electron
  for "the desktop app" would mean we maintain two desktop toolchains
  forever, and we'd have to decide on every feature whether it lives
  in the tray (Tauri) or the main app (Electron), knowing users will
  install both.

### The Tauri alternative (recommended)

Tauri v2 has already been selected for the `duraclaw-tray` app. Its
webview mode is just a Vite-built React app in a Rust-hosted WebView2/
WKWebView/WebKitGTK window — the same thing Electron does, minus the
Chromium bundle and 100+ MB.

A "Duraclaw Desktop" design using Tauri v2 looks like:

```
apps/duraclaw-tray/             # already planned; promote scope
  src-tauri/
    tauri.conf.json             # {"app":{"windows":[{"url":"index.html", ...}]}}
    binaries/                   # sidecars: cc-gateway, mdsync, session-runner(*)
    src/main.rs                 # tray + window + sidecar lifecycle + deep links
  src/                          # React UI — imports from orchestrator build
```

At that point "Duraclaw Desktop" is a superset of "Duraclaw Tray":

- Boot: tray icon visible, no window.
- Click tray or deep link → open a webview window loading the bundled
  `dist/client/` against a localhost address.
- The bundled app talks to the hosted Worker exactly like the web
  client; the sidecars handle VPS daemon lifecycle for users who
  self-host.

Two specific Tauri v2 features matter here:

- **`tauri-plugin-updater`** — cross-platform auto-update from GitHub
  Releases or a custom endpoint. Electron's `electron-updater` does
  the same but is heavier.
- **`tauri-plugin-deep-link`** — `duraclaw://` URL routing from the
  OS into the webview, including cold-start handling. Electron has
  `app.setAsDefaultProtocolClient`; comparable.

A realistic size comparison for the same feature set:

| Distribution | Electron | Tauri v2 |
|--------------|----------|----------|
| macOS DMG    | ~90 MB   | ~8 MB    |
| Windows NSIS | ~80 MB   | ~5 MB    |
| Linux .deb   | ~110 MB  | ~10 MB   |
| Memory idle  | ~200 MB  | ~60 MB   |

### When Electron would actually win

If we needed:

- Deep Node.js integration in the main process (e.g. embedding the
  session-runner itself into the desktop app rather than dialing a
  VPS). Tauri would require a Rust port of that code, which we
  wouldn't do.
- A complex off-main-thread worker graph with Node APIs.
- Plugins only available in the Node ecosystem (e.g. some obscure
  native DB driver).

None of these apply today. The `session-runner` is a detached child
process on the gateway; we're not embedding the SDK into a desktop
app. If that changed — say, we wanted a fully offline Duraclaw that
runs the runner locally — Electron might re-enter the conversation,
but we'd first ask whether the tray's Bun-compiled sidecar
architecture (already planned) already solves it, and it probably
does.

## Comparison matrix

| Target | Distribution | Shell size | Notifications | Auth model | When it ships | Net recommendation |
|--------|--------------|-----------|---------------|------------|---------------|--------------------|
| **PWA** (status quo) | install from browser | 0 MB extra | Web Push (VAPID) | cookie | Phase 4 (in-flight) | Foundation; finish it first |
| **Capacitor iOS/Android** | App Store / Play Store / sideload | 30–60 MB `.ipa`/`.apk` | APNs / FCM via `@capacitor/push-notifications` | bearer token | Phase 8.3 (already committed) | **Yes** — but add bearer auth first |
| **Ionic Framework** (`@ionic/react`) | n/a (UI lib inside Capacitor) | adds ~300 KB gz deps | n/a | n/a | n/a | **No** — duplicates Radix |
| **Tauri v2 Desktop** (expand tray scope) | DMG / MSI / deb / rpm / AppImage | ~5–10 MB | OS-native | reuse bearer | merge with tray work | **Yes** — promote tray to desktop shell |
| **Electron Desktop** | DMG / MSI / deb | ~80–160 MB | OS-native | reuse bearer | n/a | **No** — Tauri covers the same ground cheaper |

## Phasing recommendation

If this research converts to an implementation plan, the order would
be:

1. **Finish Phase 4 PWA + Web Push.** Already in-flight. Installable
   web app on Android + desktop browsers. iOS desktop browsers get
   the app; iOS mobile doesn't get push but does get install.
2. **Add bearer-token auth path** to the Worker (Better Auth bearer
   plugin, bearer-accepting WS upgrade, `X-Client-Platform` header
   convention). Small, self-contained, unblocks both shells.
3. **Add `platform` column to `push_subscriptions`** and a dispatch-
   router in the DO event handler. Still ships value on day one via
   Web Push, is ready to route APNs/FCM when the mobile app appears.
4. **Promote `apps/duraclaw-tray` to `apps/duraclaw-desktop` (Tauri
   v2)** — keep tray behaviours, add a main window that loads
   `dist/client/`. The sidecar story from the April 10 research
   stays intact.
5. **`apps/duraclaw-mobile` (Capacitor bare, no Ionic Framework)** —
   wraps `dist/client/`, adds push + filesystem + haptics plugins,
   publishes TestFlight / Play Internal Testing first.

Steps 4 and 5 can run in parallel once step 2 lands — they don't
share code beyond `dist/client/` and the Worker API contract.

## Open questions

1. **Distribution channels.** Mobile App Store vs. sideload vs.
   TestFlight is a policy choice driven by who we want installing
   it. A sideload-only `.apk` via our site would let power users
   try it without a Play Store review cycle.
2. **iOS background push reliability.** APNs delivery is best-effort
   with OS-level coalescing. If we need guaranteed "your session is
   waiting for approval" alerts, we may need Live Activities +
   ActivityKit rather than (or in addition to) push. Out of scope
   for the first shell.
3. **Desktop auto-update channel.** Ship from GitHub Releases? A
   custom Tauri updater endpoint? Homebrew tap for macOS? Matters
   once we have a real user count; not blocking.
4. **Local SQLite on mobile.** Roadmap Phase 8.1 pairs Capacitor with
   `@capacitor-community/sqlite` for local cache. We already have
   TanStack DB + OPFS persistence on web — the mobile shell would
   need a swap-in persistence adapter. The `@tanstack/browser-db-
   sqlite-persistence` package we already depend on may or may not
   have a Capacitor-SQLite binding; worth verifying before Phase 8.
5. **Runner-on-desktop.** If we ever want "run a session locally
   without a VPS" as a desktop-only feature, Tauri's sidecar path
   already prototyped for the tray is the mechanism — no Electron
   needed.

## Appendix: why this doc disagrees with the roadmap on any point

The roadmap's only mention of desktop shells is via Phase 8.3
(Capacitor) and the implicit Tauri tray in the April 10 research. It
doesn't currently say "don't use Electron" anywhere — this doc makes
that explicit after the Tauri decision. If a future need arises that
Tauri can't cover, this recommendation should be revisited on its
merits, not treated as a ban.

The roadmap's mention of "Ionic" is shorthand for Capacitor; this doc
splits the two deliberately because conflating them leads people to
pull in `@ionic/react` when we don't want it. The spec for Phase 8.3
should use "Capacitor" throughout.
