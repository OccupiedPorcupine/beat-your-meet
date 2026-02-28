# Deterministic Meeting Time Fix Plan (Revised)

Date: 2026-03-01  
Owner: Agent runtime (`agent/`) + optional UI payload enhancement (`frontend/`)

## Goal

Make the bot reliably answer time questions from runtime state (not stale prompt snapshots):
- "What time is it?"
- "How long has this meeting been going?"
- "How much time is left on this item?"

## Why the previous approach was risky

The prior routing idea depended on transcript callbacks (`user_input_transcribed`) to "intercept" questions. In the current LiveKit pipeline, this can race with normal LLM turn generation and cause duplicate or conflicting replies.

## Feasible Architecture

Use a custom agent subclass and short-circuit inside `llm_node(...)` for time queries:
1. Query text is detected from the latest user message.
2. If it is a time query and feature flag is enabled, return deterministic text directly from `MeetingState`.
3. Otherwise delegate to default LLM behavior.

This keeps all speech in the same turn pipeline (no extra `session.say(...)` race) and avoids double responses.

## Non-Goals

- No redesign of agenda state machine.
- No replacement of LiveKit transport/session APIs.
- No dependency on browser/client clock as source of truth.

## Design Principles

1. Agent process remains the single source of truth for time.
2. Time answers are computed at response time from `MeetingState`.
3. Tangent/time-warning/transition monitoring loop behavior remains unchanged.
4. Changes are additive and backward compatible for agenda payload consumers.

## Implementation Steps

## 1) Add deterministic time snapshot API in `MeetingState`

File: `agent/monitor.py`

Add:
- `def get_time_status(self, now: float | None = None) -> dict:`

Returned fields:
- `meeting_started: bool`
- `current_time_iso: str`
- `total_meeting_minutes: float`
- `current_item_topic: str`
- `current_item_elapsed_minutes: float`
- `current_item_remaining_minutes: float` (clamped `>= 0`)
- `current_item_allocated_minutes: float`
- `meeting_overtime_minutes: float`

Rules:
- If `now` is not provided, use `time.time()` at call time.
- If meeting has not started, return `meeting_started=False` and zeroed numeric values.
- `meeting_overtime_minutes` must include both:
  - finalized overtime already accumulated in `self.meeting_overtime`
  - active-item overrun `max(0, current_item_elapsed_minutes - current_item_allocated_minutes)`

Compatibility:
- Additive method only; existing call sites unaffected.

## 2) Add deterministic helpers in `agent/main.py`

Add pure helpers:
- `_is_time_query(text: str) -> bool`
- `_format_time_status_for_tts(status: dict) -> str`

Behavior:
- Detector is conservative and phrase-based (case-insensitive).
- Formatter returns 1-2 concise sentences.
- If meeting not started: explicit "meeting clock has not started yet" response.

## 3) Introduce a custom facilitator agent subclass

File: `agent/main.py`

Add class:
- `class BeatFacilitatorAgent(Agent):`

Constructor inputs:
- existing instruction/stt/vad/llm/tts params
- `meeting_state: MeetingState`
- `deterministic_time_queries_enabled: bool`

Override:
- `llm_node(chat_ctx, tools, model_settings)`

Logic in `llm_node`:
1. Read latest user utterance from `chat_ctx`.
2. If deterministic flag is on and `_is_time_query(...)` is true:
   - `status = meeting_state.get_time_status()`
   - `reply = _format_time_status_for_tts(status)`
   - yield/return deterministic text directly (no LLM call).
   - log `time_query_path=deterministic`.
3. Else:
   - log `time_query_path=llm` (only when query check runs).
   - delegate to `super().llm_node(...)`.

Important:
- Do not add deterministic time replies via `session.say(...)` in transcript callbacks.
- Keep `_monitoring_loop` unchanged.

## 4) Wire subclass into session startup

File: `agent/main.py`

Replace current `Agent(...)` construction with `BeatFacilitatorAgent(...)`.

Keep:
- `await session.start(agent, room=ctx.room)`
- existing `_refresh_agent_instructions(...)` path
- existing monitoring task and `_guarded_say(...)` paths

Compatibility:
- Non-time queries keep current LLM behavior.
- Time queries use deterministic path in the same turn engine.

## 5) Prompt guidance update (fallback clarity)

File: `agent/prompts.py`

Update facilitator prompt:
- Mention that runtime deterministic path may handle time questions.
- If asked about time and runtime values are unavailable, say uncertainty briefly; do not guess.

This is supplemental only; correctness comes from `llm_node` short-circuit.

## 6) Optional agenda payload enhancement (additive)

File: `agent/main.py` in `_send_agenda_state`

Add optional fields:
- `server_now_epoch`
- `meeting_start_epoch`
- `item_start_epoch`

Frontend:
- `frontend/components/AgendaDisplay.tsx` may consume if present.
- If absent, current interpolation logic stays unchanged.

## 7) Feature flag and parsing

Files:
- `agent/main.py`
- `.env.example` (document flag)

Flag:
- `DETERMINISTIC_TIME_QUERIES` with explicit parser:
  - truthy: `1,true,yes,on`
  - falsey: `0,false,no,off`
  - unset default: `true`

Rollback:
- set `DETERMINISTIC_TIME_QUERIES=false`

## 8) Tests (required before merge)

Folder: `agent/tests/`

Add `test_deterministic_time_queries.py` with:
1. `get_time_status()` before start.
2. `get_time_status()` after start with mocked time.
3. Remaining-time clamp at zero.
4. Overtime includes active-item overrun.
5. `_is_time_query()` positive and negative cases.
6. `_format_time_status_for_tts()` concise output.
7. Subclass routing test:
   - time query -> deterministic branch, no LLM call
   - non-time query -> fallback to LLM path

Keep using `unittest` and `unittest.mock.patch`; no new deps.

## 9) Logging and observability

File: `agent/main.py`

Add structured logs for deterministic path:
- `time_query_detected`
- `time_query_path=deterministic|llm`
- `total_meeting_minutes`
- `current_item_remaining_minutes`

Do not include transcript content in these specific logs.

## 10) Acceptance Criteria

Functional:
1. Time questions at t+1, t+7, t+15 in the same item return server-aligned values.
2. Replies remain accurate during long items without instruction refreshes.
3. Non-time interventions (tangent, warning, transition, wrap-up) are behaviorally unchanged.

Safety:
1. No duplicate bot replies for a single time question.
2. No exceptions introduced in monitoring loop.
3. Frontend agenda rendering remains valid with or without new optional fields.
4. Existing tests + new tests pass.

## File-Level Change Map

- `agent/monitor.py`
  - add `get_time_status(now: float | None = None)`
- `agent/main.py`
  - add `_is_time_query`
  - add `_format_time_status_for_tts`
  - add `BeatFacilitatorAgent` subclass with `llm_node` short-circuit
  - wire feature flag parsing
  - add deterministic-path logs
  - optionally add timestamp payload fields in `_send_agenda_state`
- `agent/prompts.py`
  - add deterministic-time fallback guidance
- `agent/tests/test_time_context.py` (existing)
  - keep current coverage
- `agent/tests/test_deterministic_time_queries.py` (new)
  - add deterministic route coverage
- `.env.example`
  - document `DETERMINISTIC_TIME_QUERIES=true`
- `frontend/components/AgendaDisplay.tsx` (optional)
  - optional support for new absolute timestamp fields

## Definition of Done

- All agent tests pass.
- Manual live-room verification confirms deterministic time responses.
- No regression observed in tangent/time warning behavior in same session.
