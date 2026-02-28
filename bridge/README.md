# Google Meet Bridge

The bridge allows the Beat Your Meet AI facilitator to join Google Meet calls. It launches a real Chrome browser, joins the meeting, and pipes audio bidirectionally between Google Meet and a LiveKit room where the agent operates.

## Architecture

```
Google Meet participants
        │
        │ WebRTC audio
        ▼
┌──────────────────────────────┐
│   Chrome Browser (Playwright) │
│                                │
│   bridge.js (injected)         │
│   ├─ RTCPeerConnection hook    │──── captures all incoming audio
│   ├─ AudioContext mixer        │──── mixes participant tracks
│   ├─ LiveKit JS SDK            │──── publishes mixed audio to LiveKit
│   │                            │
│   ├─ LiveKit subscription      │◄─── receives agent TTS from LiveKit
│   └─ getUserMedia override     │──── plays agent audio as "microphone"
│                                │
└──────────────────────────────┘
        │                  ▲
        │ publish audio    │ subscribe to agent
        ▼                  │
┌──────────────────────────────┐
│        LiveKit Room           │
│                                │
│   google-meet-bridge (pub)     │
│   beat-your-meet-agent (sub)   │◄─── agent is unchanged
│                                │     VAD → STT → LLM → TTS
└──────────────────────────────┘
```

## How It Works

### 1. Orchestrator (`main.py`)

Python script that uses Playwright to:
- Launch Chrome with a persistent profile (preserving Google login)
- Set `window.__BRIDGE_CONFIG__` with LiveKit credentials before page load
- Navigate to the Google Meet URL
- Use `meet_automation.py` to click through the join flow
- Inject `bridge.js` into the page after joining
- Monitor for meeting end and clean up

### 2. Meet Automation (`meet_automation.py`)

Handles Google Meet's UI:
- Dismisses cookie/consent dialogs
- Turns off camera and mic on the pre-join screen
- Clicks "Join now" or "Ask to join"
- Detects and waits in the admission lobby (up to 5 minutes)
- Detects when the meeting has ended

### 3. Audio Bridge (`bridge.js`)

Injected JavaScript that runs inside the Google Meet page. Does two things:

**Capturing Meet audio (Meet → LiveKit):**
- Overrides `window.RTCPeerConnection` before Meet creates its peer connections
- Every incoming audio track from a Meet participant gets intercepted via the `track` event
- All captured tracks are mixed into one stream using `AudioContext` + `MediaStreamDestination`
- The mixed stream is published to a LiveKit room using the LiveKit JS SDK (loaded from CDN)

**Playing agent audio into Meet (LiveKit → Meet):**
- Overrides `navigator.mediaDevices.getUserMedia`
- When Google Meet requests the microphone, it gets a fake audio stream instead
- The bridge subscribes to the agent's audio track from LiveKit
- Agent TTS audio is routed into the fake microphone stream via Web Audio API
- Google Meet sends this to all participants as if the bot is talking

**Echo cancellation:**
- A gain node on the capture path can be muted during agent speech
- Listens for `agent_speaking` messages on the LiveKit data channel
- Fades capture to 0 while agent speaks, fades back when done

## Setup

### Prerequisites

- Python 3.10+
- Google Chrome installed (not Chromium)
- Existing Beat Your Meet environment (.env with LiveKit + API keys)

### Install

```bash
cd bridge
pip install -r requirements.txt
playwright install chromium
```

### First-Time Google Login

The bridge needs a logged-in Chrome profile. Run this once:

```bash
cd bridge
python -c "
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        user_data_dir='.chrome-profile',
        headless=False,
        channel='chrome',
        args=['--disable-blink-features=AutomationControlled'],
        ignore_default_args=['--enable-automation'],
    )
    input('Log into Google, then press Enter...')
    ctx.close()
"
```

If Google blocks the sign-in ("This browser or app may not be secure"), copy your existing Chrome profile instead:

```bash
# macOS
cp -r ~/Library/Application\ Support/Google/Chrome/Default bridge/.chrome-profile
```

The `.chrome-profile/` directory is gitignored.

### Running

The bridge is normally launched automatically by the server when a user clicks "Join Google Meet" in the frontend. To run it manually for testing:

```bash
cd bridge
python main.py --meet-url "https://meet.google.com/abc-defg-hij" --room-name "meet-test123"
```

## File Overview

| File | Language | Purpose |
|------|----------|---------|
| `main.py` | Python | Playwright orchestrator — launches Chrome, joins Meet, injects bridge script |
| `bridge.js` | JavaScript | Audio bridge — captures Meet audio, publishes to LiveKit, plays agent audio back |
| `meet_automation.py` | Python | Google Meet UI automation — clicks join, handles dialogs and lobby |
| `requirements.txt` | — | Python dependencies |

## How the Server Triggers It

The FastAPI server (`server/main.py`) has three bridge-related endpoints:

- `POST /api/google-meet` — Creates a LiveKit room, spawns `bridge/main.py` as a subprocess
- `GET /api/bridge-status/{room_name}` — Returns bridge process status
- `POST /api/bridge-stop/{room_name}` — Terminates the bridge subprocess

The bridge subprocess inherits all environment variables from the server process.

## Known Limitations

- **Headed mode required**: Chrome must run with a display (macOS is fine, Linux needs Xvfb)
- **Google bot detection**: Google may block automated browsers; stealth flags help but aren't guaranteed
- **Meet UI changes**: Google can update Meet's DOM at any time, breaking the automation selectors in `meet_automation.py`
- **Mixed audio**: All Meet participants arrive as one mixed stream — speaker diarization accuracy is lower than per-track transcription
- **Added latency**: The chain (Meet → browser → LiveKit → agent → LiveKit → browser → Meet) adds ~400-1000ms compared to native LiveKit meetings
