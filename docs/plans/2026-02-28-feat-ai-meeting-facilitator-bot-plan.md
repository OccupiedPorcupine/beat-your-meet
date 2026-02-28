---
title: "feat: AI Meeting Facilitator Bot (Beat Your Meet)"
type: feat
date: 2026-02-28
context: Mistral Worldwide Hackathon, Singapore (Mar 1-2, 2026) — API Track
team: Hackiedonz
---

# AI Meeting Facilitator Bot — "Beat Your Meet"

## Overview

Build an AI-powered meeting facilitator bot that joins a web-based meeting room as a voice participant. The bot generates time-boxed agendas, monitors conversation in real-time via speech-to-text, and barges in with voice when participants go off-topic or overrun their time. Participants can also address the bot directly for summaries, time checks, and agenda queries.

**Hackathon targets:** ElevenLabs "Best Use of Voice" prize + Mistral Vibe "Best Agentic Coding" prize.

## Problem Statement / Motivation

Meetings go off the rails. People tangent, time boxes get ignored, and no one enforces the agenda. Existing solutions (Otter.ai, Fireflies) are passive transcribers — they record what happened but don't intervene. Beat Your Meet is an active participant that keeps meetings on track in real-time.

## Proposed Solution

A standalone web meeting room (not a Zoom/Meet plugin) with an AI bot participant. The architecture:

```
┌──────────────────┐     ┌───────────────┐     ┌──────────────────┐
│  Next.js Frontend│     │  LiveKit Cloud │     │  Python Agent    │
│                  │◄───►│  (WebRTC SFU)  │◄───►│  (livekit-agents)│
│  - Onboarding UI │     │  - Audio routing│    │  - VAD (Silero)  │
│  - Agenda display│     │  - Data channels│   │  - STT (Deepgram)│
│  - Room controls │     │               │     │  - LLM (Mistral) │
└──────┬───────────┘     └───────────────┘     │  - TTS (11Labs)  │
       │                                        └──────┬───────────┘
       │            ┌───────────────┐                   │
       └───────────►│  FastAPI      │◄──────────────────┘
                    │  - Token gen  │
                    │  - Agenda API │
                    └───────────────┘
```

## Technical Approach

### AI Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Meeting intelligence | **Mistral Large** (`mistral-large-latest`) | Core reasoning — agenda generation, tangent detection, Q&A. $2/M input tokens, 128k context |
| Tangent monitoring | **Mistral Small** (`mistral-small-latest`) | Fast, cheap periodic checks. $0.2/M input tokens |
| Speech-to-text | **Deepgram** (Nova-2, via `livekit-plugins-deepgram`) | Streaming with interim results, ~300-500ms latency, existing LiveKit plugin, $200 free credits |
| Text-to-speech | **ElevenLabs** (`eleven_turbo_v2_5`, via `livekit-plugins-elevenlabs`) | Natural voice, lowest latency model, targets ElevenLabs prize |
| Voice activity detection | **Silero VAD** (via `livekit-plugins-silero`) | Local, fast, no API cost |
| WebRTC infrastructure | **LiveKit Cloud** (free tier) | Handles rooms, audio routing, participant management |

### Key Architectural Decisions

1. **Standalone web app** (not Zoom/Meet plugin) — demo-friendly, no OAuth, full control over UX
2. **LiveKit Agents Framework** — purpose-built for AI bots in rooms; handles all WebRTC complexity
3. **Two-model architecture** — Mistral Small for fast periodic monitoring (~100ms TTFT), Mistral Large for agenda generation and spoken responses
4. **Time-driven agenda progression** — bot auto-advances when time boxes expire, host can override by voice
5. **Keyword-based bot addressing** — participant says "Hey Bot" or "Bot," followed by a question. Simple, reliable, no custom wake-word model
6. **Deepgram over Vauol Mini** — existing LiveKit plugin saves hours of integration; not worth the risk of a custom plugin for a 2-day build

### Latency Budget (Target: < 3s to first audio)

| Stage | Expected Latency |
|-------|-----------------|
| VAD detection | ~200ms |
| Deepgram STT (streaming) | ~300-500ms |
| Mistral API TTFT | ~200-400ms |
| First sentence generation | ~150-300ms |
| ElevenLabs TTS first chunk | ~300-500ms |
| WebRTC delivery | ~50-100ms |
| **Total** | **~1.2-2.0s** |

### Agenda Item State Machine

```
                ┌──────────┐
                │ UPCOMING │
                └────┬─────┘
                     │ (previous item completes OR host says "next")
                ┌────▼─────┐
          ┌─────│  ACTIVE  │─────┐
          │     └────┬─────┘     │
     (80% time)  (100% time)  (host override)
          │          │           │
    ┌─────▼───┐ ┌───▼────┐     │
    │ WARNING │ │OVERTIME│     │
    └─────┬───┘ └───┬────┘     │
          │          │           │
          └──────────┴───────────┘
                     │
               ┌─────▼─────┐
               │ COMPLETED │
               └───────────┘
```

### Bot Personality Modes

| Mode | Tangent tolerance | Tone | Example |
|------|------------------|------|---------|
| **Gentle** | 60s off-topic | Warm, suggestive | "Just a gentle nudge — we've got 5 minutes left for Q1 roadmap." |
| **Moderate** | 30s off-topic | Friendly but firm | "Hey team, let's circle back — we're running behind." |
| **Aggressive** | 10s off-topic | Direct, action-oriented | "We're off-topic. Back to the roadmap." |

## Implementation Phases

### Phase 1: Foundation (Saturday morning, ~4 hours)

**Goal:** Skeleton app with all services connected.

- [ ] Set up project structure: Next.js frontend + Python backend + LiveKit agent
  - `frontend/` — Next.js app
  - `agent/` — Python LiveKit agent
  - `server/` — FastAPI server for token gen + agenda API
- [ ] Configure all external service accounts and verify API keys work
  - LiveKit Cloud project → `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
  - Deepgram API key
  - ElevenLabs API key
  - Mistral API key (hackathon $15 credits, Scale Plan)
- [ ] Implement token generation endpoint (`server/main.py`)
  - `POST /api/token` — takes `room_name` + `participant_name`, returns JWT
- [ ] Implement basic LiveKit room page (`frontend/app/room/[id]/page.tsx`)
  - `LiveKitRoom` + `RoomAudioRenderer` + participant list + mute toggle
  - Audio-only, no video
- [ ] Implement minimal agent that joins room and can speak (`agent/main.py`)
  - `VoicePipelineAgent` with Silero VAD + Deepgram STT + ElevenLabs TTS
  - Use `livekit-plugins-openai` LLM with Mistral base_url for OpenAI-compatible interface
  - Verify: agent joins room, transcribes audio, can call `agent.say("Hello")`

**Deliverable:** A web page where a person can join a room and hear the bot say hello.

### Phase 2: Core Intelligence (Saturday afternoon + evening, ~6 hours)

**Goal:** Agenda generation + monitoring + barge-in loop.

- [ ] Build onboarding page (`frontend/app/page.tsx`)
  - Text input for meeting description + total duration
  - Display generated agenda with editable time boxes
  - Bot style selector (gentle / moderate / aggressive)
  - "Create Meeting" button → calls server → creates room → redirects to room page
- [ ] Implement agenda generation endpoint (`server/main.py`)
  - `POST /api/agenda` — takes meeting description + duration, returns structured JSON agenda via Mistral Large
  - Use `response_format={"type": "json_object"}` for reliable parsing
- [ ] Implement monitoring loop in agent (`agent/main.py`)
  - Sliding window transcript buffer (last 60s of raw text + periodic summary of older content)
  - Every 15-30s: send transcript window + current agenda item to Mistral Small with function calling
  - Function tool: `assess_conversation(status, should_speak, spoken_response)`
  - `tool_choice="any"` to force structured assessment
- [ ] Implement barge-in via `agent.say()`
  - When `should_speak=True`: generate spoken response via Mistral Large (streaming)
  - Pipe streamed text → ElevenLabs TTS → room audio
  - Cooldown: minimum 30s between interventions to avoid annoying participants
- [ ] Implement agenda state tracking
  - Track `current_item_index`, `item_start_time`, `elapsed_minutes`
  - Auto-advance with bot announcement when time box expires
  - Inject current state into every Mistral monitoring call

**Deliverable:** A meeting where the bot monitors conversation and barges in when off-topic or over time.

### Phase 3: Polish + Q&A (Sunday morning, ~4 hours)

**Goal:** Direct Q&A, intro message, agenda UI.

- [ ] Implement bot introduction
  - When first participant joins: bot says "Hi everyone, I'm Beat, your meeting facilitator. Today's agenda has N items. Let's start with [first item]."
- [ ] Implement participant Q&A
  - Detect "hey bot" or "bot," in transcript → classify as direct address
  - Generate response via Mistral Large with full meeting context
  - Common queries: "how much time left?", "summarize so far", "what's next?"
- [ ] Add live agenda display to room page
  - Show agenda items with time allocations
  - Highlight current item with countdown timer
  - Use LiveKit data channel to sync agenda state from agent → frontend
- [ ] Tune Mistral prompts based on testing
  - False positive tangent detection → adjust prompt
  - Response tone → adjust per personality mode
  - Response length → keep to 1-2 sentences max

**Deliverable:** A polished demo-ready meeting experience.

### Phase 4: Demo Prep (Sunday afternoon, ~2 hours)

**Goal:** Rehearsed demo that reliably triggers the "wow" moment.

- [ ] Write a demo script with planned tangent that triggers bot intervention
- [ ] Pre-test on demo machine/browser (Chrome recommended)
- [ ] Record a backup video of the demo in case of live failure
- [ ] Prepare 2-minute pitch: problem → solution → demo → tech stack → prizes targeted

## Acceptance Criteria

### Functional Requirements

- [ ] Host can describe a meeting and get a structured agenda with time allocations
- [ ] Host can adjust agenda items and time boxes before starting
- [ ] Host can select bot personality (gentle / moderate / aggressive)
- [ ] Shareable room URL lets participants join with browser mic
- [ ] Bot introduces itself when the meeting starts
- [ ] Bot transcribes all participants in real-time
- [ ] Bot detects off-topic conversation and barges in with voice redirect
- [ ] Bot warns when agenda item time is running out
- [ ] Bot auto-advances to next agenda item when time expires
- [ ] Participants can ask the bot questions by saying "Hey Bot"

### Non-Functional Requirements

- [ ] Barge-in latency < 3 seconds from detection to first audio
- [ ] Bot responses are 1-2 sentences max (no monologuing)
- [ ] Total Mistral API cost per demo run < $1
- [ ] Works in Chrome on the demo machine

## Dependencies & Risks

### External Service Dependencies

| Service | Risk | Mitigation |
|---------|------|------------|
| LiveKit Cloud | Free tier limits | Verify before hackathon; 5-participant room should be fine |
| Mistral API | Rate limits / credit exhaustion | Scale Plan for higher limits; $15 credits = ~2.5M output tokens |
| Deepgram | API latency / downtime | $200 free credits buffer; Nova-2 is stable |
| ElevenLabs | Character limit (10k/mo free) | Keep responses short; upgrade to $5 Starter plan if needed |

### Technical Risks

1. **STT → LLM → TTS latency exceeds 3s** — Mitigation: pre-compute common responses, use Mistral Small for monitoring, streaming TTS
2. **False positive tangent detection** — Mitigation: conservative prompts, require high confidence, cooldown between interventions
3. **Browser mic permission issues during demo** — Mitigation: pre-test on exact demo machine, have backup recording
4. **LiveKit agent dispatch quirks** — Mitigation: use `dev` mode which auto-dispatches; test early

### Cut List (Explicitly Not Building)

- No avatar/visual representation of the bot
- No voice input during onboarding (text only)
- No post-meeting summary generation
- No mobile-responsive design
- No authentication or user accounts
- No Vauol Mini STT (using Deepgram instead)
- No persistent meeting history

## Tech Stack & File Structure

```
beat-your-meet/
├── frontend/                    # Next.js app
│   ├── app/
│   │   ├── page.tsx             # Onboarding: meeting description → agenda → create room
│   │   └── room/[id]/page.tsx   # Meeting room: participant list, agenda display, controls
│   ├── components/
│   │   ├── AgendaEditor.tsx     # Editable agenda with time boxes
│   │   ├── AgendaDisplay.tsx    # Live agenda in meeting room with timer
│   │   ├── StyleSelector.tsx    # Gentle / moderate / aggressive picker
│   │   └── ParticipantList.tsx  # Who's in the room
│   └── package.json             # next, livekit-client, @livekit/components-react
│
├── agent/                       # Python LiveKit agent
│   ├── main.py                  # Agent entrypoint: VoicePipelineAgent + monitoring loop
│   ├── monitor.py               # Tangent detection + agenda state machine
│   ├── prompts.py               # All Mistral system prompts and templates
│   └── requirements.txt         # livekit-agents, livekit-plugins-*, mistralai
│
├── server/                      # FastAPI backend
│   ├── main.py                  # Token generation + agenda generation endpoints
│   └── requirements.txt         # fastapi, uvicorn, livekit-api, mistralai
│
├── docs/
│   ├── brainstorms/
│   └── plans/
└── .env                         # All API keys (gitignored)
```

### Python Dependencies

```
# agent/requirements.txt
livekit-agents[codecs]>=0.8
livekit-plugins-deepgram>=0.6
livekit-plugins-elevenlabs>=0.7
livekit-plugins-silero>=0.6
livekit-plugins-openai>=0.6
mistralai
```

```
# server/requirements.txt
fastapi
uvicorn
livekit-api>=0.6
mistralai
python-dotenv
```

### Frontend Dependencies

```json
{
  "dependencies": {
    "next": "^14",
    "react": "^18",
    "livekit-client": "^2",
    "@livekit/components-react": "^2",
    "@livekit/components-styles": "^1"
  }
}
```

## Pre-Hackathon Checklist (Do Before Saturday)

- [ ] Create LiveKit Cloud account + project → get URL, API key, API secret
- [ ] Create Deepgram account → get API key (free $200 credits)
- [ ] Create ElevenLabs account → get API key, pick a voice
- [ ] Claim Mistral API coupon ($15 credits) → ensure Scale Plan is active
- [ ] Install Python dependencies locally and verify imports work
- [ ] Run LiveKit Agents minimal example to verify agent can join a room
- [ ] Install Next.js + LiveKit React components and verify basic room UI

## References & Research

### Key Documentation

- LiveKit Agents Quickstart: `https://docs.livekit.io/agents/quickstart/`
- LiveKit React Components: `https://docs.livekit.io/reference/components/react/`
- Mistral API Docs: `https://docs.mistral.ai/`
- Mistral Python SDK: `pip install mistralai` — use `Mistral(api_key=...)` client
- ElevenLabs TTS API: `https://elevenlabs.io/docs/`
- Deepgram Nova-2: `https://developers.deepgram.com/`

### Critical API Patterns

**Mistral — Agenda Generation:**
```python
client = Mistral(api_key=os.environ["MISTRAL_API_KEY"])
response = await client.chat.complete_async(
    model="mistral-large-latest",
    messages=[...],
    response_format={"type": "json_object"},
    temperature=0.3,
    max_tokens=1024,
)
```

**Mistral — Tangent Detection (function calling):**
```python
response = await client.chat.complete_async(
    model="mistral-small-latest",
    messages=[...],
    tools=[assess_conversation_tool],
    tool_choice="any",  # Force structured assessment
    temperature=0.1,
    max_tokens=256,
)
```

**LiveKit Agent — Barge-in:**
```python
# VoicePipelineAgent has agent.say() for proactive speech
await agent.say("Hey team, we're off-topic. Let's get back to the roadmap.")
```

**LiveKit — Mistral as OpenAI-compatible LLM:**
```python
from livekit.plugins.openai import LLM
mistral_llm = LLM(
    model="mistral-large-latest",
    api_key=os.environ["MISTRAL_API_KEY"],
    base_url="https://api.mistral.ai/v1",
)
```

### Brainstorm Source

- [2026-02-28-meeting-bot-brainstorm.md](docs/brainstorms/2026-02-28-meeting-bot-brainstorm.md)
