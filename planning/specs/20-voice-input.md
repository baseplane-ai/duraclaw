---
initiative: voice-input
type: project
issue_type: feature
status: draft
priority: medium
github_issue: 20
created: 2026-04-19
updated: 2026-04-19
phases:
  - id: p0
    name: "Spec + design decision lock"
    tasks:
      - "Lock STT routing strategy (client Web Speech primary, server Whisper fallback)"
      - "Lock transcript commit UX (populate draft, never auto-send)"
      - "Lock permission model (browser mic permission, stored in user_preferences)"
      - "Lock Phase 2 audio upload ceiling (30s per utterance)"
      - "Align on SessionAgent mixin interface before Phase 2 code lands"
    test_cases: []
  - id: p1
    name: "Client-side Web Speech capture"
    tasks:
      - "Add VoiceInputButton component in packages/ai-elements"
      - "Wire VoiceInputButton into PromptInput (draft textarea)"
      - "Wire VoiceInputButton into AskUserQuestion answer field"
      - "Add voice_input_enabled column on user_preferences (ProjectRegistry DO)"
      - "Gracefully disable the button on browsers without SpeechRecognition"
    test_cases:
      - id: "voice-web-speech-button-toggle"
        description: "Clicking the mic button in PromptInput toggles recording state and renders an active indicator"
        type: "integration"
      - id: "voice-web-speech-commits-to-draft"
        description: "A final SpeechRecognition result appends to the PromptInput draft without auto-sending"
        type: "integration"
      - id: "voice-web-speech-fills-gate-answer"
        description: "Speaking into the AskUserQuestion mic populates the answer input and leaves the approve action user-initiated"
        type: "integration"
      - id: "voice-web-speech-permission-denied"
        description: "When mic permission is denied, the UI shows a helpful message and the session is not blocked"
        type: "integration"
      - id: "voice-web-speech-unsupported-browser"
        description: "On browsers lacking SpeechRecognition, the button is hidden (not throwing) and the draft flow works normally"
        type: "smoke"
  - id: p2
    name: "Server-side withVoiceInput mixin on SessionAgent"
    tasks:
      - "Add withVoiceInput mixin at apps/orchestrator/src/agents/mixins/with-voice-input.ts"
      - "Expose submitAudio(chunks, meta) as @callable RPC on SessionAgent"
      - "Bind Workers AI Whisper (@cf/openai/whisper) via wrangler.toml [ai]"
      - "Emit voice_transcript event back to client; render inline in the same surfaces as Phase 1"
      - "Rate-limit submitAudio per user per minute; 30s utterance ceiling"
    test_cases:
      - id: "voice-server-submit-wav"
        description: "Posting a small WAV via submitAudio returns a transcript with non-empty text and confidence"
        type: "integration"
      - id: "voice-server-oversize-rejected"
        description: "Audio longer than 30s is rejected with a clear error code (not silently truncated)"
        type: "unit"
      - id: "voice-server-rate-limit"
        description: "N+1 submitAudio calls within the rate window are rejected with a 429-shaped error"
        type: "unit"
      - id: "voice-server-fallback-used-when-web-speech-missing"
        description: "Client transparently falls back to submitAudio when SpeechRecognition is unavailable and voice_input_enabled is on"
        type: "integration"
---

# Voice Input — `withVoiceInput` mixin on SessionAgent (A.5)

> GitHub Issue: [#20](https://github.com/baseplane-ai/duraclaw/issues/20)
> Progress tracker: `planning/progress.md` — Agent-Orch Drop-In A.5

## Overview

Duraclaw's north star is full mobile session interaction. Typing on a phone while
approving tool calls and steering a Claude Code / Codex / OpenCode session is the
friction that breaks parity with desktop. Voice input fixes the hot paths:
dictating a prompt, answering an `AskUserQuestion` gate, and speaking a short
tool-approval rationale.

This spec phases the work:

- **Phase 1** — client-only, Web Speech API. Fast to ship, zero server cost.
- **Phase 2** — `withVoiceInput` mixin on `SessionAgent` that runs Workers AI
  Whisper. Used as a fallback when Web Speech is unavailable or the user opts in.

The mixin name and placement mirror the existing agent-orch mixin pattern
(see Agent-Orch drop-in A.2 for the SessionDO gateway relay example).

## Design decisions (locked by this spec)

| # | Decision | Choice | Reason |
|---|----------|--------|--------|
| 1 | STT routing | Hybrid — client Web Speech primary, server Whisper fallback | Free fast path for most sessions, quality + portability fallback for Safari / iOS quirks |
| 2 | Transcript commit UX | Populate draft; never auto-send | Avoids the "accidentally sent half-formed thought" mobile bug |
| 3 | Permission model | Browser mic permission, persisted in `user_preferences.voice_input_enabled` | One source of truth, no custom permission dialog to maintain |
| 4 | Phase 2 upload ceiling | 30 seconds per utterance | Anything longer is a prompt, not an answer; caps Workers AI spend |
| 5 | Language | English-only to start; language enum in settings for later expansion | Ships Phase 1 / 2 faster; localisation is a separate project |
| 6 | Mixin shape | `withVoiceInput(BaseClass)` returning a class that adds a `submitAudio` @callable RPC and emits `voice_transcript` events | Matches existing mixin conventions in the orchestrator |

## Feature Behaviors

### B1: Mic button in PromptInput

**Core:**
- **ID:** `voice-prompt-input-mic`
- **Trigger:** User taps / clicks the mic icon in `PromptInput`.
- **Expected:** Recording starts; interim transcript renders inline; final transcript appends to the draft textarea. User still presses send.
- **Verify:** `verify:voice:web-speech` browser script toggles the button, injects a mocked `SpeechRecognitionEvent`, asserts the draft textarea value.
- **Source:** `packages/ai-elements/src/prompt-input.tsx` (extended), new `packages/ai-elements/src/voice-input.tsx`.

#### UI Layer
- New `<VoiceInputButton>` component: mic icon, active/inactive states, long-press capture on touch devices, click-to-toggle on desktop.
- Interim transcript shown in a subtle line above the textarea; cleared on final.
- Disabled + tooltip on browsers without `SpeechRecognition` (hidden when `voice_input_enabled=false`).

#### API Layer
- None for Phase 1. Client-only.

#### Data Layer
- New `user_preferences.voice_input_enabled` column (ProjectRegistry DO SQLite). Defaults to `true` when browser support is detected on first login, `false` otherwise.

---

### B2: Mic button inside AskUserQuestion gate

**Core:**
- **ID:** `voice-gate-answer-mic`
- **Trigger:** A gate card for `AskUserQuestion` is visible and the user activates its mic button.
- **Expected:** Recording starts; final transcript fills the answer input. The Approve / Deny action stays user-initiated.
- **Verify:** Same `verify:voice:web-speech` script drives the gate surface end-to-end.
- **Source:** `packages/ai-elements/src/ask-user-question-card.tsx` (extended).

#### UI Layer
- Same `VoiceInputButton` component, embedded into the gate card.
- Error states match the PromptInput surface for consistency.

#### API Layer / Data Layer
- None for Phase 1 beyond the shared preference from B1.

---

### B3: `submitAudio` RPC on `SessionAgent`

**Core:**
- **ID:** `voice-session-submit-audio`
- **Trigger:** Client calls `session.submitAudio(chunks, meta)` via the Agents SDK RPC — either as the primary path (Web Speech unavailable) or because the user opted into server STT.
- **Expected:** DO runs Workers AI Whisper on the audio, returns `{ transcript, confidence }`. A `voice_transcript` event streams so other connected clients see the same result (multi-tab / multi-device).
- **Verify:** `verify:voice:server` posts a small WAV via curl, asserts transcript matches expected text modulo stopwords.
- **Source:** new `apps/orchestrator/src/agents/mixins/with-voice-input.ts`, applied to the `SessionAgent` class.

#### UI Layer
- Same client components. A hook selects route: Web Speech if supported, otherwise `submitAudio` via Agents SDK RPC.

#### API Layer
- New `@callable submitAudio(chunks: Uint8Array[], meta: { mime: string; duration: number; lang?: string }): Promise<{ transcript: string; confidence?: number }>`.
- Emits `voice_transcript` event (shape: `{ transcript, confidence, timestamp }`).
- Rate limit: per-user per-minute budget; returns `{ error: 'rate_limited', retry_after_ms }` shape when exceeded.
- Rejects `duration > 30_000` with `{ error: 'audio_too_long' }`.

#### Data Layer
- Workers AI binding in `wrangler.toml`:
  ```toml
  [ai]
  binding = "AI"
  ```
- No persistent storage of audio bytes — transcript is emitted as an event, audio is discarded after the Whisper call returns. (If durable retention becomes a feature, a separate spec.)

## Verification policy (per AGENTS.md)

Two targeted commands, both added as Phase 1 and Phase 2 ship:

- `pnpm verify:voice:web-speech` — real browser via `chrome-devtools-axi`. Exercises B1 and B2.
- `pnpm verify:voice:server` — real curl against a local orchestrator + gateway. Exercises B3.

Evidence files:

- `.kata/verification-evidence/phase-voice-input-p1-<date>.md`
- `.kata/verification-evidence/phase-voice-input-p2-<date>.md`

`pnpm verify:smoke` baseline must stay green across both phases.

## Out of scope (follow-ups)

- **Voice output (TTS).** Separate concern; can share the same settings panel when it lands.
- **Wake-word / always-on listening.** Needs a larger privacy + power story.
- **Multi-language auto-detection.** Ships English-only first; language enum reserved in settings but not wired.
- **Server-side audio retention.** Audio bytes discarded after Whisper returns. If retention becomes a feature, separate spec.

## Risks

- **Safari iOS `SpeechRecognition` quirks.** Partially mitigated by the server fallback, but the UX message needs care.
- **Workers AI cost.** Bounded by the 30s-per-utterance ceiling and per-user rate limit. Revisit if usage spikes.
- **Gate approval attention model.** Voice answer in the gate card shouldn't race with the existing keyboard path — the mic must be clearly an *alternative* input, not an auto-accept.

## Dependencies

None hard. Preference storage lives in ProjectRegistry DO which already owns `user_preferences` (Phase 6.1 shipped).

## Links

- Progress tracker item A.5 — `planning/progress.md`
- Roadmap north star — `planning/specs/roadmap-v2-full-vision.md`
- Related Phase 11 mobile work (#29 / #30 / #31) — complements voice input but does not block it
