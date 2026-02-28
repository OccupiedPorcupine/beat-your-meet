# Beat Your Meet — Brainstorm

**Date:** 2026-02-28
**Context:** Mistral Worldwide Hackathon, Singapore edition (Mar 1-2)
**Track:** API Track
**Team:** Hackiedonz

---

## What We're Building

An AI-powered meeting facilitator bot that joins a web-based meeting room as a voice participant. The bot:

1. **Onboards** the meeting host before the call — generates a structured agenda with time-boxed topics and estimated durations, which the host reviews and approves
2. **Listens** to all participants in real-time via speech-to-text transcription
3. **Monitors** the conversation against the approved agenda + time allocations
4. **Barges in** with voice when participants tangent off-topic or overrun their time box, redirecting them back to the agenda
5. **Answers questions** — participants can address the bot directly mid-meeting for summaries, clarifications, or agenda checks
6. **Adapts** to the host's preferred interaction style (aggressive vs gentle reminders, formal vs casual tone)

### The "That's So Cool" Factor

Imagine being in a meeting and an AI voice interrupts: "Hey team, we've been on the office snack debate for 4 minutes now — we still need to cover the Q1 roadmap before time's up. Want to park this one?" That's the moment.

---

## Why This Approach

### Platform: Standalone Web Meeting Room (not Zoom/Meet)

- Judges can join a URL instantly — no app install, no meeting link friction
- Full control over audio pipeline and UX
- Weekend-feasible vs fighting Zoom SDK OAuth/webhooks

### Architecture: LiveKit Agents Framework

- Purpose-built for AI bots that join rooms, listen, and speak
- Handles all WebRTC complexity (rooms, audio streams, participant management)
- Has an agent SDK with STT/TTS plugin support
- Lets us focus on AI logic instead of infrastructure plumbing

### AI Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Meeting intelligence | **Mistral Large 3** (API) | Core reasoning — agenda generation, tangent detection, Q&A responses |
| Speech-to-text | **Vauol Mini** or Whisper (via LiveKit STT plugin) | Transcribe participant audio to text |
| Text-to-speech | **ElevenLabs** | Natural voice for the bot — targets ElevenLabs special prize |
| Code generation | **Mistral Vibe** | Build the project — targets Vibe special prize |

### Special Prizes Targeted

1. **ElevenLabs** — Best use of voice AI (bot speaks with ElevenLabs voice)
2. **Mistral Vibe** — Best use of agentic coding (project built with Vibe)

---

## Key Decisions

1. **No avatar for v1** — Too complex for a weekend prototype. Voice-only bot presence. Avatar can be a v2 stretch goal.
2. **Standalone web app** over Zoom/Meet integration — demo-ability and feasibility win.
3. **LiveKit Agents** as the WebRTC backbone — don't reinvent the wheel on audio infrastructure.
4. **Time-boxed agenda as the core mechanic** — The bot generates a structured rundown with time estimates. Host approves. Bot enforces. This is cleaner than freeform "tangent detection" because it gives the AI a concrete schedule to monitor against.
5. **ElevenLabs for TTS** — Natural voice + prize eligibility.
6. **API Track** — Focus on the experience, not fine-tuning pipelines.

---

## Core User Flow

### Pre-Meeting (Onboarding)
1. Host opens the web app
2. Host describes the meeting purpose, topics, and goals (text input or voice)
3. Bot (Mistral Large 3) generates a structured agenda:
   ```
   1. Standup updates (10 min)
   2. Q1 roadmap review (15 min)
   3. Hiring pipeline (10 min)
   4. Open discussion (5 min)
   ```
4. Host reviews, adjusts, approves
5. Host configures bot style: gentle / moderate / aggressive reminders
6. Host gets a shareable meeting room link

### During Meeting
1. Participants join via URL
2. Bot introduces itself briefly (ElevenLabs voice)
3. Bot silently transcribes and monitors conversation
4. When tangent detected or time exceeded → bot barges in with voice
5. Participants can ask bot questions: "Hey bot, how much time do we have left?" / "Summarize what we've agreed on so far"

### Post-Meeting
- Bot generates meeting summary with key decisions and action items (stretch goal)

---

## Open Questions

1. **LiveKit free tier limits** — Need to verify if the free tier is sufficient for the hackathon demo (likely yes for small rooms)
2. **Latency budget** — STT → Mistral → TTS pipeline latency. Need to ensure the bot's "barge in" feels responsive (target: < 3s)
3. **Vauol Mini vs Whisper for STT** — LiveKit has Whisper/Deepgram plugins out of the box. Vauol Mini would require a custom plugin but would score points for using more Mistral models
4. **How aggressive should tangent detection be?** — Need to tune the prompt to avoid false positives. The bot should be helpful, not annoying
5. **Team composition** — How many people on the team? Who handles frontend vs backend vs AI logic?

---

## Tech Stack Summary

- **Frontend:** Next.js or simple React app with LiveKit client SDK
- **Backend:** Python (LiveKit Agents SDK is Python-native)
- **AI:** Mistral Large 3 (API), ElevenLabs TTS
- **Infrastructure:** LiveKit Cloud (free tier)
- **Dev tool:** Mistral Vibe for code generation
