# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Beat Your Meet is an AI meeting facilitator that joins LiveKit audio rooms, monitors conversation against an agenda, and intervenes when participants go off-topic or exceed time limits. It uses Mistral for LLM, Deepgram for STT, ElevenLabs for TTS, and LiveKit for real-time audio.

## Architecture

Three independent services that communicate via LiveKit and HTTP:

- **`frontend/`** — Next.js 14 + TypeScript + Tailwind. Meeting setup UI (agenda generation, style selection) and in-meeting room UI. Connects to LiveKit for audio and receives agenda state updates via LiveKit data channels (topic: `"agenda"`).
- **`server/`** — FastAPI Python backend. Handles LiveKit token generation (`/api/token`), Mistral-powered agenda generation (`/api/agenda`), and room creation (`/api/room`). Room metadata (agenda + style) is stored in LiveKit room metadata.
- **`agent/`** — LiveKit Agents framework Python service. The core AI facilitator that joins rooms as a voice participant. Uses a `VoicePipelineAgent` with Silero VAD + Deepgram STT + Mistral LLM + ElevenLabs TTS. Runs a monitoring loop every 15s using Mistral Small for fast tangent detection via tool calling.

Data flow: Frontend → Server (create room with agenda/style in metadata) → Agent (reads metadata on join, runs monitoring loop, sends agenda state back to frontend via data channel).

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

- **Mistral Large** for agenda generation and the main facilitator LLM (via OpenAI-compatible API). **Mistral Small** for the fast 15-second monitoring loop tangent checks.
- The agent uses Mistral's **tool calling** (`assess_conversation` tool) for structured tangent detection with confidence thresholds (only intervenes at >0.7 confidence).
- Three facilitation styles (`gentle`, `moderate`, `aggressive`) control intervention tone and tangent tolerance (60s/30s/10s respectively).
- `MeetingState` in `agent/monitor.py` is a state machine tracking `ItemState` transitions: UPCOMING → ACTIVE → WARNING (at 80% time) → OVERTIME → COMPLETED. Supports host override via EXTENDED state with a grace period.
- Intervention cooldown of 30 seconds prevents the bot from being too chatty.
- Transcript buffer keeps only the last 2 minutes of conversation.
