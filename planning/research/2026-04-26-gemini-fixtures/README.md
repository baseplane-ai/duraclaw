# Gemini CLI stream-json fixtures (P1 spike, GH#110)

Captured 2026-04-27 03:18 UTC against `gemini` CLI v0.39.1 on the dev VPS. Used `GEMINI_API_KEY` (no OAuth — see auth findings in research doc).

Invocation pattern:
```bash
gemini -y --skip-trust --output-format stream-json --prompt "<text>"
gemini -y --skip-trust --resume <UUID>  --output-format stream-json --prompt "<text>"
```

## Files

| File | Scenario | Lines | Wall time |
|------|----------|-------|-----------|
| `text-only.jsonl` | Trivial text response (`Reply with only the word PONG`) | 4 | ~7.5s |
| `tool-call.jsonl` | One `run_shell_command` tool call (`echo HELLO`) | 8 | ~7.1s |
| `resume.jsonl` | Resume of `tool-call`'s session, follow-up question | 4 | ~6.8s |

## Confirmed event types

- `init` — `{type, timestamp, session_id, model}` — emitted first; `session_id` is the resume token
- `message{role:user}` — input echo; **adapter must filter** (we already know the input)
- `message{role:assistant, delta:true}` — **incremental text chunks**; adapter accumulates
- `tool_use` — `{type, timestamp, tool_name, tool_id, parameters}` — single event per call (NOT partial+complete); `tool_id` is short alphanumeric (~8 chars), not UUID
- `tool_result` — `{type, timestamp, tool_id, status}` — **NO `output` field**; only status (success/error/...). Tool stdout is NOT in the stream
- `result` — terminal event with rich `stats`: `{total_tokens, input_tokens, output_tokens, cached, input, duration_ms, tool_calls, models: {<model_name>: {...}}}`

## Notable absences (vs Claude/Codex)

- No `delta:false` finalisation event — last `delta:true` is the final; stream end signalled by `result`
- No tool output in `tool_result` — adapter cannot surface tool stdout/stderr to UI
- No `thinking` / reasoning blocks
- No content-block array on assistant messages — `content` is a flat string

## Latency

| Phase | Time | Notes |
|-------|------|-------|
| CLI startup overhead | ~4.2s | Bun-based bundle; constant per spawn |
| Model duration (`stats.duration_ms`) | 3.2–3.7s | Trivial prompts |
| Wall total | 6.8–7.5s | Per-turn cost on respawn-per-turn architecture |

## Cost note

System prompt overhead is heavy: 13.5k input tokens for a 4-character response (text-only fixture). `stats.cached` reflects prompt-cache hits across turns (8.1k cached on resume).
