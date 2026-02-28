---

title: "feat: Debug Mode for Beat Your Meet"
type: feat
date: 2026-02-28
owner: codex
status: proposed

# Debug Mode Plan — Forcefulness Slider + AI Thought Window

## Goals

Add an opt-in Debug Mode to the meeting room with two capabilities:

1. A continuous slider to control how forceful the facilitator is.
2. A live panel showing the facilitator's decision process.

## Current Status (As-Is)

- The current product has a 3-state style selector (`gentle`, `moderate`, `aggressive`).
- There is no numeric forcefulness control in runtime today.
- A slider added only in UI would not change agent behavior unless wired through transport + agent policy updates.
- This plan defines the full wiring so the slider changes behavior live during a meeting.

## Scope

In scope:
- Frontend controls and debug UI in the room page.
- Runtime propagation of forcefulness from UI to agent.
- Agent instrumentation to publish structured debug events.
- Safe, structured "thought process" visibility (decision trace, not hidden model chain-of-thought).

Out of scope:
- Persisting debug logs to external storage.
- Replay UI for historic sessions.
- Multi-agent orchestration.

## Existing Stack (Used)

- Frontend: Next.js App Router + React + Tailwind (`frontend/`)
- Realtime transport: LiveKit room + data channels
- Backend API: FastAPI (`server/main.py`)
- Agent runtime: `livekit-agents` (`agent/main.py`)
- LLMs: Mistral (`mistral-large-latest`, `mistral-small-latest`)

## Technology Choices

### 1) Forcefulness control transport

Recommended: LiveKit data channel (`topic: "debug-control"`) from frontend to agent.

Why:
- Already in use for agenda state (`topic: "agenda"`).
- Lowest operational complexity (no new server websocket infra).
- Correct scope (room-local state, low latency).

Alternatives considered:
- FastAPI REST polling: simple but high latency and wasteful.
- FastAPI WebSocket relay: flexible, but extra moving parts for no clear benefit.

### 2) Thought process visibility

Recommended: Agent emits structured debug events via LiveKit data channel (`topic: "debug-events"`).

Why:
- Same real-time transport as room state.
- Easy subscribe model for all participants in debug mode.
- Keeps agent as source of truth for decisions.

Alternatives considered:
- Server-side event bus + SSE: better persistence options, more complexity now.
- Browser-only derived logs: incomplete, misses agent-internal checks.

### 3) Forcefulness implementation model

Recommended: Unified numeric score `forcefulness` in range `[0,100]` mapped to behavior knobs.

Behavior knobs controlled by score:
- Tangent tolerance seconds
- Minimum intervention cooldown
- Message tone directive
- Confidence threshold for intervention

Why:
- More expressive than current enum (`gentle|moderate|aggressive`).
- Easy backward compatibility by mapping presets to default values.

Alternatives considered:
- Keep only enum styles: too coarse for debugging/tuning.
- Multiple separate sliders: more control but harder UX and harder to explain.

## Data Contracts

### Debug control message (frontend -> agent)

```json
{
  "type": "debug_control",
  "debug_enabled": true,
  "forcefulness": 62,
  "style": "moderate",
  "timestamp": 1760000000
}
```

Notes:
- `style` remains for compatibility with existing prompt paths.
- `forcefulness` is primary runtime value.

### Debug event message (agent -> frontend)

```json
{
  "type": "debug_event",
  "event": "tangent_assessment",
  "ts": 1760000000,
  "current_item": "Roadmap risks",
  "inputs": {
    "elapsed_minutes": 8.2,
    "forcefulness": 62,
    "transcript_window_secs": 60
  },
  "decision": {
    "status": "drifting",
    "confidence": 0.81,
    "should_speak": true,
    "reason_summary": "Conversation shifted to hiring for >40s while roadmap risks is active"
  },
  "output": {
    "spoken_preview": "Let's circle back to roadmap risks so we stay on time."
  }
}
```

Important:
- `reason_summary` is a concise, user-facing rationale.
- Do not expose full hidden reasoning traces.

## UX Plan

### A) Debug mode toggle

Location:
- Room page header, near mute/leave controls.

Behavior:
- Off by default.
- When off: no debug panel shown; agent still runs normal behavior.
- When on: shows slider + live event panel.

### B) Forcefulness slider

Location:
- Inside debug panel.

Spec:
- Range: `0..100`
- Step: `1`
- Default mapping from style:
  - gentle -> 25
  - moderate -> 55
  - aggressive -> 85

Displayed helper text:
- `0-33`: permissive, fewer interventions.
- `34-66`: balanced.
- `67-100`: strict and frequent interventions.

### C) Thought window (decision trace panel)

UI:
- Scrollable panel with reverse chronological events.
- Event chips: `assessment`, `warning`, `intervention`, `transition`, `error`.
- Each event includes timestamp, confidence, short reason, and spoken preview if any.

Retention:
- Keep last 200 events in memory in frontend state.

## Agent Logic Changes

File targets:
- `agent/main.py`
- `agent/monitor.py` (if needed for policy helpers)
- `agent/prompts.py`

### 1) Runtime config model

Add in-memory config object:

- `debug_enabled: bool = False`
- `forcefulness: int = 55`
- Derived fields recomputed on update:
  - `tangent_tolerance_sec`
  - `intervention_cooldown_sec`
  - `intervention_confidence_threshold`
  - `style_instruction_override`

### 2) Subscribe to control channel

On session start:
- Register data handler for `debug-control` topic.
- Parse/validate payload.
- Update runtime config atomically.
- Emit `config_updated` debug event.

Concrete implementation notes:
- In `entrypoint()`, after `session.start(...)`, register a room data handler.
- Decode JSON only for `topic == "debug-control"`.
- Clamp `forcefulness` to `0..100`.
- Recompute derived thresholds on each update.

### 3) Emit structured debug events

Add helper:
- `_publish_debug_event(room, event_type, payload)`

Emit at these points:
- Each periodic tangent assessment
- Time warning trigger
- Overtime transition
- Intervention spoken
- LLM/tool failures

### 5) Forcefulness mapping (required wiring)

Add a single mapping function in `agent/main.py` and use it from monitoring logic:

```python
def policy_from_forcefulness(forcefulness: int) -> dict:
    f = max(0, min(100, int(forcefulness)))
    return {
        # lower value => more permissive, higher => stricter/faster interventions
        "tangent_tolerance_sec": int(75 - (f * 0.55)),   # ~75 -> 20
        "intervention_cooldown_sec": int(45 - (f * 0.30)),  # ~45 -> 15
        "confidence_threshold": max(0.55, 0.90 - (f * 0.0035)),  # ~0.90 -> 0.55
        "warning_lead_ratio": min(0.95, 0.70 + (f * 0.0020)),  # warn earlier when forceful
    }
```

Apply these values in code paths:
- Tangent checks: skip intervention until transcript drift exceeds `tangent_tolerance_sec`.
- Decision gate: only speak when `confidence >= confidence_threshold`.
- Cooldown gate: replace fixed cooldown with `intervention_cooldown_sec`.
- Time warnings: trigger by `warning_lead_ratio` instead of a fixed warning point.

### 4) Prompt adjustments

Current `STYLE_INSTRUCTIONS` is enum-based. Extend to blend style + forcefulness:
- Keep enum template.
- Append forcefulness directive string, e.g.:
  - low: "Prefer non-interruption unless clearly off-topic."
  - high: "Intervene quickly when drift is detected and keep redirection direct."

## Frontend Changes

File target:
- `frontend/app/room/[id]/page.tsx`
- Optional new components:
  - `frontend/components/DebugPanel.tsx`
  - `frontend/components/ForcefulnessSlider.tsx`
  - `frontend/components/ThoughtTrace.tsx`

Implementation:
- Add debug toggle state.
- Add forcefulness state.
- Publish control messages via LiveKit data channel.
- Subscribe to `debug-events` topic and append events.
- Render panel only when debug mode is enabled.

Concrete wiring steps:
1. Add state in `RoomPage`:
   - `const [debugEnabled, setDebugEnabled] = useState(false);`
   - `const [forcefulness, setForcefulness] = useState(55);`
2. On slider change, publish to LiveKit:
   - `room.localParticipant.publishData(...)` with `topic: "debug-control"`.
3. Debounce publishes (100-200ms) to avoid flooding.
4. Also publish when debug toggle changes so agent knows whether to emit verbose debug events.

Example payload from frontend:

```ts
const payload = new TextEncoder().encode(
  JSON.stringify({
    type: "debug_control",
    debug_enabled: debugEnabled,
    forcefulness,
    style,
    timestamp: Date.now(),
  })
);
await room.localParticipant.publishData(payload, { reliable: true, topic: "debug-control" });
```

## Backend/API Changes

Recommended: none required for MVP.

Optional (later):
- Add server endpoints to set org-level defaults for forcefulness.
- Persist debug logs for after-action review.

## Safety and Privacy

- Do not surface full model chain-of-thought.
- Emit concise reason summaries only.
- Mask obvious PII patterns in transcript excerpts before event emission.
- Debug mode should be visibly labeled to participants.

## Rollout Plan

Phase 1: UI and transport plumbing
- Add debug toggle + slider UI.
- Implement `debug-control` publish.
- Implement agent control subscribe.

Phase 2: Decision trace instrumentation
- Emit `debug-events` from agent.
- Render thought window list and categories.

Phase 3: Behavior tuning
- Tune mapping function from score -> thresholds.
- Validate with scripted conversation scenarios.

## Acceptance Criteria

- Host can toggle debug mode in room UI.
- Host can move slider and agent behavior changes within 2 seconds (verified by changed intervention cadence and debug event thresholds).
- Thought window updates in real time with assessments and interventions.
- Event payload includes confidence and concise reason summary.
- No full hidden reasoning traces are exposed.

## Definition of Done for Slider Wiring

- Slider value is transmitted to agent over LiveKit data channel.
- Agent logs `config_updated` with new `forcefulness` and derived thresholds.
- At low forcefulness (e.g. 15), interventions are less frequent and later.
- At high forcefulness (e.g. 85), interventions are faster/more direct.
- Behavior change happens without restarting server, frontend, or agent.

## Testing Strategy

Unit tests:
- Mapping function `forcefulness -> thresholds` (edge values 0, 33, 66, 100).
- Debug payload validation and fallback behavior.

Integration tests:
- Join room, enable debug mode, receive debug events.
- Change slider while meeting is active and verify changed intervention cadence.

Manual scenarios:
- On-topic discussion should produce no unnecessary interventions at low score.
- Off-topic tangent should trigger fast intervention at high score.
- Time-overrun warnings should become earlier/more direct as score increases.

## Risks and Mitigations

Risk: Debug stream becomes noisy.
- Mitigation: Event sampling or per-type throttling.

Risk: UI lag from high event volume.
- Mitigation: Cap to 200 events + lightweight event objects.

Risk: Misinterpretation of "thought process" as guaranteed model introspection.
- Mitigation: Label panel as "Decision Trace (summarized)".

## Estimated Effort

- Frontend debug panel + slider + channel wiring: 3-4 hours
- Agent runtime control + event emitter: 4-6 hours
- Prompt and threshold tuning: 2-3 hours
- Testing and polish: 2-3 hours

Total: ~11-16 hours

## Suggested Next Step

Implement Phase 1 first (transport + slider) before building the thought window so behavior tuning can start immediately.
