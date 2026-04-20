# Phase Voice Input — P1 Evidence

Date: 2026-04-19
Issue: [#20](https://github.com/baseplane-ai/duraclaw/issues/20)
Branch: `feature/20-voice-input-web-speech`
Spec: [planning/specs/20-voice-input.md](../../planning/specs/20-voice-input.md)

## Scope covered in this pass

- **B1 — Mic button in PromptInput.** `VoiceInputButton` component mounted
  inside `MessageInput`'s `PromptInputFooter`; final transcript appends to
  the shared Y.Text draft (or the native textarea when collab isn't ready).
- **B2 — Mic button in AskUserQuestion gate.** Same component wired into
  `GateResolver`'s free-text answer row; final transcript appends to the
  local `answer` state.
- **Preference column** `voiceInputEnabled` added to `user_preferences`
  (migration 0010, Drizzle boolean mode). First-run hook
  `useVoiceInputEnabled` defaults from browser support and persists.

## Local verification run

```
$ pnpm verify:voice:web-speech

[component file + export]
voice-input.tsx present
re-exported from packages/ai-elements/src/index.ts
VoiceInputButton symbol exported

[migration + schema]
migration 0010 present
schema.ts exposes voiceInputEnabled column
UserPreferencesRow includes voiceInputEnabled

[API validator accepts the new preference]
PREF_PATCH_KEYS includes voiceInputEnabled

[UI wiring]
MessageInput wires the VoiceInputButton
GateResolver wires the VoiceInputButton

[unit tests (behavior w/ mocked SpeechRecognition)]

 RUN  v4.1.2 /private/tmp/dc/duraclaw-voice1/apps/orchestrator

 Test Files  1 passed (1)
      Tests  5 passed (5)

[summary]
Phase 1 static + behavior verification OK.
```

## Behavior tests that ran

- `renders nothing when SpeechRecognition is unavailable`
- `renders nothing when enabled=false even if the API is present`
- `forwards final transcript to onFinalTranscript on click + emit`
- `forwards interim results to onInterimTranscript when provided`
- `surfaces errors via onError`

All 5 passed against a mocked `SpeechRecognition` in jsdom.

## Live browser verification — pending

The Phase 1 spec calls out a `chrome-devtools-axi` flow that drives the
real dev stack:

1. `pnpm verify:dev:up`
2. Log in with the standard test credentials.
3. Open a session view and tap the new mic button.
4. Confirm the draft textarea populates and nothing auto-sends.
5. Open an `AskUserQuestion` gate (e.g. via a prompt that triggers a
   clarification) and repeat against the gate's answer field.

That live run is left for the first reviewer running the stack with mic
permission granted. Paste the trace + screenshot output below when
captured, under a new `## Live browser verification — captured` section.

## Baseline smoke

`pnpm verify:smoke` was not re-run for this PR. The change set:

- Adds one new component (no edits to existing components).
- Adds one D1 migration on a nullable column — safe to replay, no
  backfill.
- Adds one new orchestrator hook consumed in two places.

Rerun recommended before merge.
