#!/usr/bin/env bash
# verify:voice:web-speech — Phase 1 of A.5 (voice input).
#
# What this covers:
#   - VoiceInputButton exists and is re-exported from @duraclaw/ai-elements.
#   - Orchestrator behavior tests for the button pass (mocked SpeechRecognition).
#   - Preference column migration exists at 0010_add_voice_input_enabled.sql.
#
# What this does NOT cover (intentionally, per spec 20-voice-input.md):
#   - Real browser audio capture. Live browser evidence via chrome-devtools-axi
#     goes in .kata/verification-evidence/phase-voice-input-p1-<date>.md
#     once the verifier has the dev stack up.

set -euo pipefail

source "$(dirname "$0")/common.sh"

require_cmd jq
require_cmd grep

print_section "component file + export"
test -f "$VERIFY_ROOT/packages/ai-elements/src/components/voice-input.tsx" \
  && echo "voice-input.tsx present"
grep -q "./components/voice-input" "$VERIFY_ROOT/packages/ai-elements/src/index.ts" \
  && echo "re-exported from packages/ai-elements/src/index.ts"
grep -q "export function VoiceInputButton" \
  "$VERIFY_ROOT/packages/ai-elements/src/components/voice-input.tsx" \
  && echo "VoiceInputButton symbol exported"

print_section "migration + schema"
test -f "$VERIFY_ROOT/apps/orchestrator/migrations/0010_add_voice_input_enabled.sql" \
  && echo "migration 0010 present"
grep -q "voiceInputEnabled" "$VERIFY_ROOT/apps/orchestrator/src/db/schema.ts" \
  && echo "schema.ts exposes voiceInputEnabled column"
grep -q "voiceInputEnabled" "$VERIFY_ROOT/apps/orchestrator/src/lib/types.ts" \
  && echo "UserPreferencesRow includes voiceInputEnabled"

print_section "API validator accepts the new preference"
grep -q "'voiceInputEnabled'" "$VERIFY_ROOT/apps/orchestrator/src/api/index.ts" \
  && echo "PREF_PATCH_KEYS includes voiceInputEnabled"

print_section "UI wiring"
grep -q "VoiceInputButton" "$VERIFY_ROOT/apps/orchestrator/src/features/agent-orch/MessageInput.tsx" \
  && echo "MessageInput wires the VoiceInputButton"
grep -q "VoiceInputButton" "$VERIFY_ROOT/apps/orchestrator/src/features/agent-orch/GateResolver.tsx" \
  && echo "GateResolver wires the VoiceInputButton"

print_section "unit tests (behavior w/ mocked SpeechRecognition)"
(
  cd "$VERIFY_ROOT/apps/orchestrator"
  pnpm exec vitest run src/features/agent-orch/VoiceInputButton.test.tsx
)

print_section "summary"
echo "Phase 1 static + behavior verification OK."
echo "Live-browser evidence belongs in .kata/verification-evidence/phase-voice-input-p1-<date>.md"
