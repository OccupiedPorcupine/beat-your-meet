# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Beat Your Meet is an AI meeting facilitator that joins LiveKit audio rooms, monitors conversation against an agenda, and intervenes when participants go off-topic or exceed time limits. It uses Mistral for LLM, Deepgram for STT, ElevenLabs for TTS, and LiveKit for real-time audio.

## Architecture

Three independent services that communicate via LiveKit and HTTP:

- **`frontend/`** — Next.js 14 + TypeScript + Tailwind. Meeting setup UI (agenda generation, style selection) and in-meeting room UI. Connects to LiveKit for audio and receives agenda state updates via LiveKit data channels (topic: `"agenda"`). Interpolates timers locally at 1s intervals between state updates.
- **`server/`** — FastAPI Python backend. Handles LiveKit token generation (`/api/token`), Mistral-powered agenda generation (`/api/agenda`), and room creation (`/api/room`). Room metadata (agenda + style) is stored in LiveKit room metadata.
- **`agent/`** — LiveKit Agents framework Python service. The core AI facilitator that joins rooms as a voice participant. Uses a `VoicePipelineAgent` with Silero VAD + Deepgram STT + Mistral LLM + ElevenLabs TTS. Time management uses event-driven asyncio timers (not polling). Tangent detection is handled by the main LLM naturally through its system prompt.

Data flow: Frontend → Server (create room with agenda/style in metadata) → Agent (reads metadata on join, sets timers for agenda items, sends agenda state to frontend on transitions and via 60s heartbeat).

## Development Commands

### Frontend
```bash
cd frontend
npm install
npm run dev          # Next.js dev server (port 3000)
npm run build        # Production build
```

### Server
```bash
cd server
pip install -r requirements.txt
python main.py       # FastAPI on port 8000
# or: uvicorn main:app --reload --port 8000
```

### Agent
```bash
cd agent
pip install -r requirements.txt
python main.py start # LiveKit agents CLI
```

### Environment
Copy `.env.example` to `.env` and fill in all keys. The `.env` file lives at the project root and is loaded by both `server/` and `agent/` via `python-dotenv` with `../.env` path resolution. Required keys: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `DEEPGRAM_API_KEY`, `ELEVEN_API_KEY`, `MISTRAL_API_KEY`. Frontend uses `NEXT_PUBLIC_SERVER_URL` and `NEXT_PUBLIC_LIVEKIT_URL`.

## Key Design Decisions

- **Mistral Large** for agenda generation and the main facilitator LLM (via OpenAI-compatible API). **Mistral Small** for item summaries and @beat chat responses only.
- **Event-driven timers** (`AgendaTimers` in `agent/main.py`) replace the old polling loop. When an agenda item starts, asyncio timers fire at 80% (warning) and 100% (auto-advance). No polling, no wasted API calls.
- **Tangent detection** is handled by the main LLM through its system prompt — every speech turn goes through `llm_node`, so the LLM naturally decides when to redirect. No separate monitoring LLM call.
- **Override handling**: when a participant says "keep going", the overtime timer is cancelled and rescheduled with a 2-minute grace period. Simple timer management, no state machine.
- Two facilitation styles (`gentle`, `moderate`) plus `chatting` mode (no facilitation). Styles control intervention tone via the system prompt.
- `MeetingState` in `agent/monitor.py` tracks agenda items (UPCOMING → ACTIVE → WARNING → OVERTIME → COMPLETED), transcripts, meeting notes, and participant tracking.
- `BeatFacilitatorAgent.llm_node` intercepts utterances for deterministic handling (time queries, skip, end meeting, doc requests, override) before falling through to the LLM.
- Intervention cooldown of 30 seconds prevents the bot from being too chatty.
- Transcript buffer keeps only the last 2 minutes of conversation.
- Frontend state updates are sent on transitions (item change, warning, overtime) and via a 60s heartbeat for clock drift correction.
