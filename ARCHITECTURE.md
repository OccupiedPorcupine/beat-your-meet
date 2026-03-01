# Beat Your Meet — Architecture

## Overview

Beat Your Meet is an AI meeting facilitator that joins LiveKit audio/video rooms as a voice participant. It monitors conversation against a structured agenda and intervenes when participants go off-topic or exceed time allocations. The system is built from three independent services that communicate via LiveKit and HTTP.

```
┌──────────────────┐        HTTP         ┌──────────────────┐
│   Frontend       │◄───────────────────►│   Server         │
│   (Next.js)      │                     │   (FastAPI)      │
│   :3000          │                     │   :8000          │
└──────┬───────────┘                     └──────┬───────────┘
       │                                        │
       │    LiveKit (WebRTC + Data Channels)    │ LiveKit API
       │                                        │
       └────────────────────┬───────────────────┘
                            │
                   ┌────────▼─────────┐
                   │  LiveKit Cloud   │
                   │  (Room Server)   │
                   └────────┬─────────┘
                            │
                   ┌────────▼─────────┐
                   │   Agent          │
                   │   (Python)       │
                   │   LiveKit Agents │
                   └──────────────────┘
```

---

## Service 1: Frontend (`frontend/`)

**Technology**: Next.js 14, TypeScript, Tailwind CSS, `@livekit/components-react`

### Pages

| Route | File | Purpose |
|---|---|---|
| `/` | `app/page.tsx` | Home — meeting setup (agenda generation, style selection) |
| `/room/[id]` | `app/room/[id]/page.tsx` | In-meeting room UI |
| `/post-meeting/[id]` | `app/post-meeting/[id]/PostMeetingPageInner.tsx` | Post-meeting document viewer |

### Room Join Flow

The room page implements a three-step flow:

1. **PIN entry** — if no `?code=` query param is present, a PIN screen is shown. The entered code is validated when a token is requested from the server.
2. **Pre-join** — LiveKit's `<PreJoin>` component handles device selection (camera/mic) and name input. On submit, it calls `POST /api/token` to get a JWT.
3. **Meeting room** — `<LiveKitRoom>` connects using the JWT. The `MeetingRoom` component renders the video grid and side panel.

### Real-Time Communication (Frontend ↔ Agent)

The frontend uses two named LiveKit data channels:

| Topic | Direction | Payload types |
|---|---|---|
| `"agenda"` | Agent → Frontend | `agenda_state`, `meeting_ended`, `docs_ready` |
| `"chat"` | Bidirectional | `chat_message` |

The frontend also sends control messages to the agent (no named topic):
- `{ type: "set_style", style: "gentle"|"moderate"|"chatting" }` — change facilitation style mid-meeting
- `{ type: "end_meeting" }` — trigger meeting end

These are published via `room.localParticipant.publishData(payload, { reliable: true })`.

### Key Components

| Component | Purpose |
|---|---|
| `AgendaDisplay` | Renders live agenda state received via data channel |
| `ChatPanel` | In-meeting text chat; `@beat` mentions are routed to the agent |
| `CustomControlBar` | Mic/camera controls + agenda/chat toggle + end meeting |
| `SmartParticipantTile` | Video tile wrapper |
| `DocList` / `DocViewer` | Post-meeting document browser |

### Post-Meeting Polling

After a meeting ends, the frontend polls `GET /api/rooms/{room_id}/docs` every 3 seconds until documents appear (max 60 seconds). Once available, the user sees a list of AI-generated documents (meeting notes, action items, etc.).

---

## Service 2: Server (`server/main.py`)

**Technology**: FastAPI, Python, `livekit-api`, `mistralai`

The server is a thin orchestration layer. It does not hold in-memory state between requests; all room state lives in LiveKit room metadata.

### API Endpoints

#### `POST /api/room`
Creates a LiveKit room with the agenda and style embedded in room metadata.

```json
// Room metadata stored in LiveKit
{
  "agenda": { "title": "...", "items": [...] },
  "style": "gentle|moderate|chatting",
  "access_code": "MEET-XXXX"
}
```

Returns `{ room_name, access_code }`. The `room_name` follows the format `meet-{8 hex chars}`. The access code is a cryptographically random 4-character uppercase string prefixed with `MEET-` (e.g. `MEET-7X3K`).

#### `POST /api/token`
Validates the access code against room metadata, then issues a LiveKit JWT for the participant. Grants: `room_join`, `can_publish`, `can_subscribe`, `can_publish_data`.

Security: The access code comparison is case-insensitive. If the room no longer exists in LiveKit, a 404 is returned.

#### `POST /api/agenda`
Calls Mistral Large to generate a structured agenda from a natural language description and total duration. Uses `response_format: json_object` to ensure valid JSON output. Returns the full agenda object.

#### `POST /api/rooms/{room_id}/docs`
Agent-only endpoint. Uploads a generated markdown document for a room. Also writes a `.meta.json` sidecar file alongside the document. Validates room ID format (`meet-[a-f0-9]{8}`) and filename format (`[a-z0-9][a-z0-9-]{0,58}\.md`) to prevent path traversal.

#### `GET /api/rooms/{room_id}/docs`
Returns a list of available documents for a room (reads `.meta.json` sidecar files).

#### `GET /api/rooms/{room_id}/docs/{filename}`
Returns the raw markdown content of a specific document.

#### `GET /api/health`
Returns `{ "status": "ok" }`.

### Document Storage

Documents are stored on the filesystem at `server/data/rooms/{room_id}/{filename}`. Each document has a corresponding `.meta.json` sidecar:

```json
{
  "filename": "summary.md",
  "title": "Meeting Summary",
  "size_bytes": 1234,
  "created_at": "2026-03-01T12:00:00+00:00"
}
```

---

## Service 3: Agent (`agent/`)

**Technology**: Python, `livekit-agents` framework, Mistral AI, Deepgram, ElevenLabs, Silero VAD

The agent is the core of the system. It runs as a LiveKit worker process, picks up jobs when new rooms are created, and joins each room as a voice participant.

### Startup

```
python agent/main.py start
```

On startup, the agent checks whether `AGENT_PORT` (default 8081) is already in use and exits early if so. It then starts the LiveKit Agents CLI worker, which connects to LiveKit cloud and waits for room jobs.

### Entrypoint Flow (`entrypoint()`)

```
Connect to room (audio-only subscribe)
    │
    ▼
Wait for first human participant
    │
    ▼
Parse room metadata → MeetingState
    │
    ▼
Configure LLM (Mistral Large via OpenAI-compatible API)
    │
    ▼
Build system prompt (facilitator or chatting mode)
    │
    ▼
Create BeatFacilitatorAgent (VAD + STT + LLM + TTS)
    │
    ▼
Create AgentSession → start()
    │
    ▼
Start meeting clock → refresh agent instructions
    │
    ▼
Deliver bot introduction (via TTS)
    │
    ▼
Send initial agenda_state to frontend
    │
    ▼
Launch monitoring loop (asyncio.Task)
```

### Voice Pipeline

The agent uses LiveKit's `VoicePipelineAgent` pattern with these components:

| Component | Technology | Config |
|---|---|---|
| VAD | Silero VAD | Default settings |
| STT | Deepgram Nova-2 | Language: English |
| LLM | Mistral Large (`mistral-large-latest`) | OpenAI-compatible API |
| TTS | ElevenLabs Turbo v2.5 | `eleven_turbo_v2_5` model |

All speech is transcribed and stored in the rolling transcript buffer (`MeetingState.transcript_buffer`, last 2 minutes) and in per-item transcript stores (`MeetingState.item_transcripts`).

### `BeatFacilitatorAgent` — Custom `llm_node`

The agent subclasses `Agent` and overrides `llm_node` to handle several cases before delegating to the LLM:

1. **Silence mode** — if a participant said a silence phrase, suppress all LLM responses until `silence_requested_until` expires, unless the participant directly addresses Beat by name.
2. **Time queries** (deterministic path) — regex patterns detect questions like "how much time is left?". If `DETERMINISTIC_TIME_QUERIES=true` (default), the answer is constructed directly from `MeetingState.get_time_status()` without an LLM call.
3. **Skip requests** — regex patterns detect "let's skip this", "move on to next topic", etc. The agent advances the agenda state immediately without an LLM call.
4. **End meeting requests** — regex patterns detect "end the meeting", "let's adjourn", etc. Triggers `_end_meeting()`.
5. **Document requests** — regex patterns detect "take attendance", "list action items", "write a summary", etc. The request is queued and fulfilled at meeting end.
6. **General LLM fallthrough** — all other utterances go to Mistral Large with the current facilitator system prompt.

### Function Tools (LLM-callable)

The agent exposes four tools that Mistral can call during conversation:

| Tool | Returns |
|---|---|
| `get_participant_count` | Count + identities of remote participants |
| `get_meeting_info` | Timing, progress, current item, overtime |
| `get_agenda` | Full agenda with item states |
| `get_meeting_notes` | Notes from completed agenda items |

### Monitoring Loop (`_monitoring_loop`)

Runs every 15 seconds as a background `asyncio.Task`. Uses **Mistral Small** (`mistral-small-latest`) for fast, cheap checks.

```
Every 15 seconds:
    │
    ├─ [chatting mode] → refresh instructions + send agenda state, continue
    │
    ├─ [no current item] → say wrap-up → _end_meeting() → break
    │
    ├─ check_time_state()
    │   ├─ WARNING (80% elapsed) → _guarded_say(TIME_WARNING)
    │   └─ OVERTIME (100% elapsed)
    │       ├─ advance_to_next()
    │       ├─ _guarded_say(TRANSITION)
    │       ├─ _summarize_item() via Mistral Small
    │       └─ continue (skip tangent check)
    │
    ├─ [has recent transcript + can_intervene_for_tangent()]
    │   └─ _check_tangent() via Mistral Small + assess_conversation tool
    │       └─ [if high confidence] → _guarded_say(TANGENT)
    │
    ├─ _refresh_agent_instructions()   ← keeps time context current
    └─ _send_agenda_state()            ← pushes state to frontend
```

### Speech Gate (`speech_gate.py`)

Every candidate utterance passes through the speech gate before being sent to TTS. The gate is a pure function — it takes `(candidate_text, trigger, MeetingContext)` and returns a `GateResult(action="speak"|"silent", ...)`.

#### Trigger types

| Trigger | Always speaks? | Notes |
|---|---|---|
| `INTRO` | Yes | Never suppressed |
| `WRAP_UP` | Yes | Never suppressed |
| `TRANSITION` | Yes (unless override grace active) | Forced if meeting overtime ≥ 5 min |
| `TIME_WARNING` | Yes (unless override grace active) | |
| `TANGENT` | Only if confidence ≥ threshold | gentle=0.80, moderate=0.70 |
| `DIRECT_QUESTION` | Yes | |
| `NAMED_ADDRESS` | Yes | Never suppressed, even during silence |

#### Suppression conditions (applied before trigger rules)

1. **Chatting mode** — only `INTRO`, `DIRECT_QUESTION`, `NAMED_ADDRESS` are ever spoken
2. **Empty candidate** — always silent
3. **Silence requested** — all triggers except `TRANSITION`, `WRAP_UP`, `NAMED_ADDRESS` are suppressed for 5 minutes
4. **Redundancy** — if >85% of words in the candidate already appear in the recent transcript, the utterance is suppressed

### Agenda State Machine (`monitor.py`)

`MeetingState` holds the authoritative agenda state. Each `AgendaItem` moves through a linear state machine:

```
UPCOMING → ACTIVE → WARNING (≥80% elapsed) → OVERTIME (≥100% elapsed) → COMPLETED
                                                    ↓
                                              (host override)
                                              EXTENDED (120s grace)
```

Key timing properties:
- `elapsed_minutes` — time since current item started
- `meeting_overtime` — cumulative overrun across all completed items
- `INTERVENTION_COOLDOWN` — 30 seconds minimum between any interventions
- `TANGENT_TOLERANCE` — gentle=120s, moderate=60s minimum since last intervention before tangent checks fire
- `override_grace_seconds` — 120s grace after host says "keep going"
- Silence signal lasts 300 seconds (5 minutes)

### Per-Item Summaries

When an item transitions to OVERTIME, `_summarize_item()` is called with Mistral Small using the `record_item_summary` tool. The resulting `ItemNotes` (key points, decisions, action items) are stored in `MeetingState.meeting_notes` and injected into the facilitator system prompt as "Meeting Memory" so the LLM is aware of what was decided earlier.

### Chat (`@beat` mentions)

Participants can type `@beat <question>` in the chat panel. The agent listens on the `"chat"` data channel topic and handles these messages in `_handle_chat_mention()`. It mirrors all voice capabilities (skip, end meeting, time queries, document requests, general LLM Q&A) but replies via text on the `"chat"` data channel rather than TTS.

### End of Meeting (`_end_meeting`)

Triggered by voice command, UI button, or automatic wrap-up:

1. Sets `state.meeting_end_triggered = True` (idempotent guard)
2. Publishes `{ type: "meeting_ended" }` on the `"agenda"` channel → frontend navigates to post-meeting page
3. Calls `generate_and_upload_all_docs()` (from `doc_generator.py`) — generates all requested documents + automatic meeting notes using Mistral
4. Uploads each document via `POST /api/rooms/{room_id}/docs`
5. Publishes `{ type: "docs_ready" }` on the `"agenda"` channel → frontend polls and renders documents

### System Prompt Refresh

`_refresh_agent_instructions()` is called after every monitoring loop iteration and after any state change (style change, item advance, skip). This ensures the agent's LLM context always contains accurate time and agenda state. Without this, the facilitator prompt would show stale elapsed/remaining times.

---

## Data Flow: Meeting Lifecycle

```
1. SETUP
   User fills out form (frontend)
   → POST /api/agenda (server generates agenda via Mistral Large)
   → POST /api/room (server creates LiveKit room with metadata)
   ← Returns { room_name, access_code }

2. JOIN
   User goes to /room/[id]?code=MEET-XXXX
   → POST /api/token (server validates code, returns LiveKit JWT)
   → LiveKit WebRTC connection established
   Agent auto-joins room (LiveKit worker picks up job)
   Agent reads metadata → MeetingState initialized

3. MEETING
   Agent TTS → "Hi, I'm Beat..."
   Agent → frontend: agenda_state (every 15s + on state change)

   Participants speak
   Deepgram STT → transcript → MeetingState.transcript_buffer

   Every 15s: monitoring loop
   ├─ Time checks → TTS interventions
   └─ Mistral Small tangent check → TTS interventions (if above threshold)

   Participant: "Hey Beat, how much time is left?"
   → deterministic time response (no LLM call)

   Participant: "@beat what did we decide earlier?"
   → Mistral Small chat response via data channel

4. END
   Voice/UI end signal
   → agent: _end_meeting()
   → "meeting_ended" on agenda channel → frontend redirects
   → generate_and_upload_all_docs() → POST /api/rooms/{id}/docs (per doc)
   → "docs_ready" on agenda channel

5. POST-MEETING
   /post-meeting/[id] polls GET /api/rooms/{id}/docs every 3s
   → Renders document list + markdown viewer
```

---

## Environment Variables

| Variable | Used by | Purpose |
|---|---|---|
| `LIVEKIT_URL` | server, agent | LiveKit server WebSocket URL |
| `LIVEKIT_API_KEY` | server, agent | LiveKit API key |
| `LIVEKIT_API_SECRET` | server, agent | LiveKit API secret |
| `MISTRAL_API_KEY` | server, agent | Mistral AI API key |
| `DEEPGRAM_API_KEY` | agent | Deepgram STT API key |
| `ELEVEN_API_KEY` | agent | ElevenLabs TTS API key |
| `NEXT_PUBLIC_SERVER_URL` | frontend | HTTP URL of the server (default: `http://localhost:8000`) |
| `NEXT_PUBLIC_LIVEKIT_URL` | frontend | LiveKit WebSocket URL |
| `AGENT_PORT` | agent | Health-check port (default: 8081) |
| `SERVER_URL` | agent | Internal URL for doc uploads (default: `http://localhost:8000`) |
| `DETERMINISTIC_TIME_QUERIES` | agent | `true`/`false` — bypass LLM for time questions (default: `true`) |

The `.env` file lives at the project root. Both `server/main.py` and `agent/main.py` resolve it via `Path(__file__).parent.parent / ".env"` so they work regardless of the current working directory.

---

## Facilitation Styles

| Style | Tangent threshold | Tangent tolerance | Tone |
|---|---|---|---|
| `gentle` | 0.80 confidence | 120s since last intervention | Kind, direct |
| `moderate` | 0.70 confidence | 60s since last intervention | Firm, clear |
| `chatting` | N/A (disabled) | N/A (disabled) | Casual Q&A only, no agenda enforcement |

Style can be changed mid-meeting from the frontend UI or via voice ("switch to gentle mode"). The agent updates `MeetingState.style` and immediately refreshes its system prompt and data-channel state.

---

## LLM Usage Summary

| Task | Model | Method |
|---|---|---|
| Agenda generation | Mistral Large | `response_format: json_object` |
| Voice facilitator (main LLM) | Mistral Large | Streaming, with function tools |
| Monitoring / tangent detection | Mistral Small | Tool calling (`assess_conversation`) |
| Per-item summarization | Mistral Small | Tool calling (`record_item_summary`) |
| Chat `@beat` replies | Mistral Small | Standard chat completion |
| Document generation | Mistral (various) | Via `doc_generator.py` |

Mistral is accessed via its native API for direct SDK calls (`mistralai` Python package) and via the OpenAI-compatible API endpoint (`https://api.mistral.ai/v1`) for the LiveKit Agents integration.
