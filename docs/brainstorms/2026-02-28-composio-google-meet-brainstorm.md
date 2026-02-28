# Brainstorm: Composio + Google Meet Integration

**Date:** 2026-02-28
**Status:** Brainstorm complete
**Feature:** Enable the AI facilitator agent to join Google Meet calls for real-time voice facilitation

---

## What We're Building

A bridge that allows the existing Beat Your Meet agent to join Google Meet calls as a real-time voice participant. Users paste a Google Meet link into the frontend UI, and the system:

1. Uses Composio (Google OAuth) to authenticate a headless browser
2. Joins the Google Meet via Puppeteer/Playwright
3. Captures Meet audio and bridges it into a LiveKit room via LiveKit's browser SDK
4. The existing agent pipeline (VAD → STT → LLM → TTS) works unchanged against the LiveKit room
5. Agent TTS output is played back into the Google Meet

The agent facilitates the Google Meet conversation exactly as it does for native LiveKit meetings today — monitoring for tangents, tracking agenda progress, and intervening when needed.

## Why This Approach

### Headless Browser + LiveKit Browser SDK

**Chosen over:**
- **SIP bridge** — Lower audio quality, requires SIP provider, needs dial-in number extraction
- **Meeting bot service (Recall.ai)** — Adds paid dependency, less control over the pipeline

**Reasons:**
- **Agent stays unchanged.** The entire VoicePipelineAgent pipeline (Silero VAD + Deepgram STT + Mistral LLM + ElevenLabs TTS) continues to operate against a LiveKit room. It doesn't need to know the audio comes from Google Meet.
- **Stays in LiveKit's ecosystem.** Audio bridging uses the LiveKit browser SDK, keeping all media routing through LiveKit infrastructure.
- **Composio handles the hard part of OAuth.** Google Meet requires authentication. Composio manages OAuth tokens/sessions so we don't need to build our own Google auth flow.
- **Full control.** No external meeting bot service dependency. We control the browser, the audio capture, and the bridge.

### Composio's Role

Composio is specifically used for **Google OAuth management** — authenticating the headless browser so it can join Google Meets that require a Google account. It handles token refresh, session management, and provides the credentials the browser needs.

## Key Decisions

1. **Trigger mechanism:** User pastes a Google Meet URL into the frontend UI (not calendar integration)
2. **Audio bridge:** Headless browser captures Meet audio via Web Audio API, publishes to LiveKit room via LiveKit JS SDK
3. **Authentication:** Composio handles Google OAuth for the headless browser session
4. **Agent architecture:** No changes to the existing agent — it joins a LiveKit room as usual
5. **Browser automation:** Puppeteer or Playwright (to be decided during planning)

## Architecture Overview

```
User pastes Meet link
        │
        ▼
   ┌─────────┐     POST /api/google-meet
   │ Frontend │ ──────────────────────────► ┌──────────┐
   └─────────┘                              │  Server  │
                                            └────┬─────┘
                                                 │
                                   ┌─────────────┼─────────────┐
                                   │             │             │
                                   ▼             ▼             ▼
                             ┌──────────┐  ┌──────────┐  ┌──────────┐
                             │ Composio │  │ Headless  │  │ LiveKit  │
                             │  OAuth   │  │ Browser   │  │  Room    │
                             └────┬─────┘  └────┬─────┘  └────┬─────┘
                                  │             │             │
                                  │  auth creds │             │
                                  └─────►┌──────┘             │
                                         │                    │
                                         │ joins Google Meet  │
                                         │ captures audio     │
                                         │ injects TTS audio  │
                                         │                    │
                                         │  LiveKit JS SDK    │
                                         └────────────────────┘
                                                              │
                                                              ▼
                                                     ┌──────────────┐
                                                     │    Agent     │
                                                     │ (unchanged)  │
                                                     │ VAD→STT→LLM→TTS
                                                     └──────────────┘
```

## New Components Needed

1. **Browser bridge service** — New process/module that runs headless Chrome, joins Google Meet, and bridges audio to LiveKit. Could live in `bridge/` or `server/google_meet_bridge.py`.
2. **Composio integration** — OAuth setup and credential management. Lives in server or bridge service.
3. **Frontend Meet link input** — UI for pasting a Google Meet URL and triggering the join flow.
4. **Server endpoint** — `POST /api/google-meet` that orchestrates the join flow (validates link, triggers Composio auth, launches browser bridge, creates LiveKit room, dispatches agent).

## Open Questions

- **Browser runtime:** Where does the headless browser run? Same machine as the server? Separate container? This affects deployment.
- **Audio quality:** Web Audio API capture quality from Google Meet — needs testing. Meet may apply noise suppression that could interfere with STT.
- **Meet UI stability:** Google Meet's DOM structure changes over time. How do we handle UI changes breaking the browser automation?
- **Concurrent meetings:** Can we run multiple headless browsers for multiple simultaneous Google Meet sessions?
- **Puppeteer vs Playwright:** Both work. Playwright has better multi-browser support and is more actively developed.
- **Composio setup:** What Composio plan/tier is needed? How does the OAuth flow work for initial setup?
- **Bidirectional audio:** How exactly do we inject the agent's TTS audio back into Google Meet? (Likely via virtual audio device or replacing the microphone input in the browser)

## Technical Risks

1. **Google Meet bot detection** — Google may detect and block headless browsers joining Meets. May need stealth plugins or undetected-chromedriver.
2. **Audio capture reliability** — Capturing clean audio from Meet's WebRTC streams via Web Audio API may be unreliable.
3. **Latency** — The chain (Meet → browser capture → LiveKit → agent → LiveKit → browser → Meet) adds latency compared to native LiveKit meetings.
4. **Meet UI changes** — Google can update Meet's interface at any time, breaking DOM selectors used for joining/interacting.
