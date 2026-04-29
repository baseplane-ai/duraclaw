# Modules Inventory

| Module | Package | Domain Question | Owns | Consumes |
|--------|---------|-----------------|------|----------|
| [orchestrator](orchestrator.md) | `apps/orchestrator/` | Where do user sessions live, and how do they sync to clients? | per-session DO, D1 registry tables, the React SPA | cloudflare integration, better-auth integration, agent-gateway |
| [agent-gateway](agent-gateway.md) | `packages/agent-gateway/` | How does duraclaw spawn and supervise per-session SDK processes? | runner process tree, the reaper, `$SESSIONS_DIR` files | session-runner, docs-runner, dynamics theory |
| [session-runner](session-runner.md) | `packages/session-runner/` | What translates between an SDK turn and a duraclaw session? | one Claude SDK `query()`, the dial-back WS, gate ack | claude-agent-sdk integration, shared-transport, agent-gateway |
| [docs-runner](docs-runner.md) | `packages/docs-runner/` | How do multiple users edit a duraclaw document simultaneously? | yjs document state, md ↔ yjs bridge, `/health` per-file map | shared-transport, agent-gateway, orchestrator |
| [shared-transport](shared-transport.md) | `packages/shared-transport/` | How does a runner reliably stream events back to its DO across transient connection loss? | `BufferedChannel` ring, `DialBackClient` reconnect state machine, terminal close-code semantics | dynamics theory, topology theory |
| [kata](kata.md) | `packages/kata/` | How is in-flight feature work paced through phases with hard stops between them? | `.kata/sessions/`, kata templates + ceremony, the four hook handlers | dynamics theory, domains theory |
| [mobile](mobile.md) | `apps/mobile/` | How does duraclaw run on Android without re-shipping a native binary for every web change? | Android Gradle module, OTA poll, FCM push wiring | capacitor integration, orchestrator |
