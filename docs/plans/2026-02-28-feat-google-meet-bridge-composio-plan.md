---
title: "feat: Google Meet Bridge via Headless Browser + Composio OAuth"
type: feat
date: 2026-02-28
brainstorm: docs/brainstorms/2026-02-28-composio-google-meet-brainstorm.md
---

# feat: Google Meet Bridge via Headless Browser + Composio OAuth

## Overview

Add a Google Meet integration to Beat Your Meet so the AI facilitator agent can join live Google Meet calls. A headless browser (Playwright) joins the Google Meet, captures audio, and bridges it to a LiveKit room where the existing agent pipeline operates unchanged. Composio manages Google OAuth authentication.

The user pastes a Google Meet URL into the frontend, the system launches a browser bridge that joins the call, and the agent facilitates the meeting in real-time — detecting tangents, tracking agenda, and speaking interventions — all through the Google Meet call.

## Problem Statement / Motivation

Currently, Beat Your Meet only works in native LiveKit rooms. Users must invite participants to a custom web app. In reality, most meetings happen on Google Meet. To deliver real value, the agent needs to join meetings where they already happen.

## Proposed Solution

A **bridge service** that runs a headed Chromium browser (via Playwright), joins Google Meet as an authenticated participant, and bidirectionally pipes audio between Google Meet and a LiveKit room. The existing agent joins the LiveKit room unchanged.

```
Google Meet  ←→  Browser Bridge  ←→  LiveKit Room  ←→  Agent (unchanged)
                      ↑
                  Composio OAuth
```

## Technical Approach

### Architecture

Four services (adding `bridge/` to the existing three):

```
beat-your-meet/
  frontend/    — Next.js: adds Google Meet URL input + bridge status display
  server/      — FastAPI: adds POST /api/google-meet endpoint
  bridge/      — NEW: Playwright Python + injected JS for audio bridging
  agent/       — UNCHANGED: joins LiveKit room as usual
```

**Data flow:**
1. Frontend → `POST /api/google-meet` (Meet URL + agenda + style)
2. Server → Creates LiveKit room with metadata → Launches bridge subprocess
3. Bridge → Authenticates via persistent Chrome profile (Composio-managed OAuth) → Joins Google Meet → Injects JS bridge script
4. JS bridge script → Captures Meet audio via `RTCPeerConnection.ontrack` interception → Publishes to LiveKit via JS SDK → Subscribes to agent audio from LiveKit → Plays into Meet via `getUserMedia` override
5. Agent → Auto-dispatched to LiveKit room → Facilitates meeting as usual

### Critical Design Decisions

#### 1. Authentication: Persistent Browser Profile + Composio

**Problem:** Composio provides OAuth2 access tokens, but Google Meet in a browser requires full session cookies (`SID`, `HSID`, `SSID`). There is no supported API to convert tokens to cookies.

**Solution (v1):** Use a **dedicated bot Google account** with a **persistent Playwright browser profile**. One-time manual login stores cookies in the profile directory. Composio manages the OAuth token for API-level tasks (validating meeting existence, getting meeting details), but browser auth uses the persistent profile.

**Why this works for v1:** The bot account logs in once. Playwright's `launch_persistent_context()` preserves the session across bridge launches. Google sessions persist for weeks before requiring re-authentication.

**Future improvement:** Build a Composio-to-cookie bridge using the refresh token to programmatically regenerate session cookies, eliminating the manual login step.

#### 2. Audio Capture: In-Browser JS Injection

**Problem:** Need to capture Google Meet audio and publish to LiveKit, and play agent audio back into Meet.

**Solution:** Inject a JavaScript bridge script into the Google Meet page that:

**Capturing Meet audio (Meet → LiveKit):**
```javascript
// Override RTCPeerConnection to intercept incoming audio tracks
const OriginalRTCPeerConnection = window.RTCPeerConnection;
window.RTCPeerConnection = function(...args) {
    const pc = new OriginalRTCPeerConnection(...args);
    pc.addEventListener('track', (event) => {
        if (event.track.kind === 'audio') {
            // Mix all incoming audio tracks into one MediaStream
            const source = audioContext.createMediaStreamSource(new MediaStream([event.track]));
            source.connect(mixerDestination);
        }
    });
    return pc;
};

// Publish mixed audio to LiveKit
const mixedTrack = mixerDestination.stream.getAudioTracks()[0];
await livekitRoom.localParticipant.publishTrack(mixedTrack, {
    name: 'meet-capture',
    source: Track.Source.Microphone,
    dtx: false,
    red: false,
});
```

**Playing agent audio into Meet (LiveKit → Meet):**
```javascript
// Override getUserMedia before Meet requests it
const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
navigator.mediaDevices.getUserMedia = async function(constraints) {
    if (constraints.audio) {
        // Return a MediaStream that we control
        return agentAudioStream; // Fed by LiveKit subscription
    }
    return originalGetUserMedia.call(this, constraints);
};

// Subscribe to agent audio from LiveKit
livekitRoom.on('trackSubscribed', (track) => {
    if (track.kind === 'audio') {
        // Route agent TTS to the fake microphone stream
        const agentSource = audioContext.createMediaStreamSource(track.mediaStream);
        agentSource.connect(agentDestination);
    }
});
```

**Why in-browser JS over alternatives:**
- **vs. puppeteer-stream:** Avoids Node.js dependency, no WebM decode/encode overhead, audio stays as `MediaStreamTrack` (zero transcoding)
- **vs. system-level capture:** No PulseAudio/virtual audio device setup, works on macOS and Linux
- **vs. Chrome extension (tabCapture):** No extension to maintain, simpler deployment

**Trade-off:** JS injection is fragile if Google Meet changes its WebRTC internals. However, `RTCPeerConnection` is a Web API standard — Meet must use it, so the interception point is stable.

#### 3. Echo Cancellation

**Problem:** Agent TTS audio is played into Meet → captured by the bridge → sent back to the agent → agent responds to its own speech (feedback loop).

**Solution:** Multi-layered approach:
1. **Mute capture during TTS:** When the agent is speaking (signaled via LiveKit data channel), temporarily disconnect the Meet audio source from the LiveKit publication track.
2. **Voice Activity Detection:** The agent's existing Silero VAD already filters silence. Combined with muting, this prevents self-triggering.
3. **Fallback — Agent transcript filtering:** The agent can ignore transcripts that match its own recent TTS output (compare against last intervention text).

#### 4. Bridge Process Management

The bridge runs as a **subprocess** spawned by the FastAPI server. This is the simplest approach for v1.

```python
# server/main.py
import subprocess

bridge_process = subprocess.Popen(
    ["python", "bridge/main.py",
     "--meet-url", meet_url,
     "--room-name", room_name,
     "--livekit-url", livekit_url],
    env={**os.environ}
)
```

The bridge reports status via **LiveKit data channel** on a `"bridge_status"` topic, which the frontend subscribes to.

**Bridge states:** `STARTING` → `AUTHENTICATING` → `JOINING_MEET` → `WAITING_ADMISSION` → `CONNECTED` → `ERROR` / `DISCONNECTED`

#### 5. User Participation Model

During a Google Meet bridge session, the **user participates in Google Meet directly** (not through the Beat Your Meet frontend). The frontend shows a "monitoring dashboard" with:
- Bridge connection status
- Live agenda progress (received via LiveKit data channel)
- Bridge health indicators

The user does NOT join the LiveKit room as an audio participant — they're already in the Google Meet.

### Implementation Phases

#### Phase 1: Bridge Core (Audio Proof-of-Concept)

**Goal:** Prove bidirectional audio works between Google Meet and LiveKit.

**Tasks:**

- [x] Create `bridge/` directory with `main.py`, `requirements.txt`, `bridge.js`
- [x] `bridge/requirements.txt`: `playwright`, `python-dotenv`, `livekit-api`
- [x] `bridge/main.py`: Playwright launcher
  - Launch persistent Chrome context with `--use-fake-ui-for-media-stream`
  - Navigate to Google Meet URL
  - Handle Meet join flow (click "Join now" / "Ask to join" button)
  - Inject `bridge.js` into the page via `page.add_script_tag()`
  - Monitor bridge health, handle cleanup on exit
- [x] `bridge/bridge.js`: In-page audio bridge script
  - Load LiveKit JS SDK via CDN (`<script>` tag or dynamic import)
  - Connect to LiveKit room with a token (passed via `window.__BRIDGE_CONFIG__`)
  - Override `RTCPeerConnection` to capture incoming Meet audio tracks
  - Mix captured tracks via `AudioContext` + `MediaStreamDestination`
  - Publish mixed audio to LiveKit room
  - Subscribe to agent audio from LiveKit
  - Override `getUserMedia` to inject agent audio as microphone input
  - Publish bridge status updates via LiveKit data channel
- [x] `bridge/meet_automation.py`: Google Meet UI interaction helpers
  - Click through "Join now" / "Ask to join" screens
  - Dismiss camera/mic permission dialogs (handled by Chrome flags)
  - Detect "waiting for admission" state
  - Detect meeting end
- [ ] Test: Manual login to bot Google account, save persistent profile
- [ ] Test: Bridge joins a Google Meet, audio flows to LiveKit, agent responds

**Success criteria:** Agent hears Google Meet participants and speaks back into the Meet.

**Files:**
```
bridge/
  main.py              — Playwright browser orchestration
  bridge.js            — In-page audio bridge (JS, injected into Meet)
  meet_automation.py   — Meet UI interaction helpers
  requirements.txt     — playwright, python-dotenv, livekit-api
```

#### Phase 2: Server Endpoint + Frontend UI

**Goal:** Wire up the user-facing flow.

**Tasks:**

- [x] `server/main.py`: Add `POST /api/google-meet` endpoint
  - Request model: `GoogleMeetRequest(meet_url: str, agenda: dict, style: str)`
  - Validate Meet URL format (regex: `https://meet.google.com/[a-z]{3}-[a-z]{4}-[a-z]{3}`)
  - Create LiveKit room with metadata: `{"agenda": ..., "style": ..., "mode": "google-meet", "meet_url": ...}`
  - Spawn bridge subprocess with room name and Meet URL
  - Return `{"room_name": "...", "status": "bridge_starting"}`
- [x] `server/main.py`: Add `GET /api/bridge-status/{room_name}` endpoint
  - Returns current bridge state from an in-memory dict (updated by bridge process)
- [x] `frontend/app/page.tsx`: Add Google Meet mode
  - Toggle/tab: "Create Room" vs "Join Google Meet"
  - Google Meet mode: text input for Meet URL + existing agenda editor + style selector
  - "Join Google Meet" button → calls `POST /api/google-meet`
  - Redirect to `/monitor/{room_name}` (new route) instead of `/room/{id}`
- [x] `frontend/app/monitor/[id]/page.tsx`: New monitoring dashboard page
  - Connect to LiveKit room (data channels only, no audio/video)
  - Display bridge status (from `"bridge_status"` data channel topic)
  - Display live agenda progress (from existing `"agenda"` data channel topic)
  - "Stop Bridge" button to end the session

**Success criteria:** User pastes a Meet link, clicks button, bridge joins, monitoring dashboard shows status and live agenda.

**Files:**
```
server/main.py                           — Add /api/google-meet endpoint
frontend/app/page.tsx                    — Add Google Meet URL input mode
frontend/app/monitor/[id]/page.tsx       — NEW: Bridge monitoring dashboard
frontend/components/BridgeStatus.tsx     — NEW: Bridge status display component
```

#### Phase 3: Composio OAuth Integration

**Goal:** Replace manual bot account login with Composio-managed OAuth.

**Tasks:**

- [ ] Set up Composio account and create Google OAuth Auth Config
- [ ] `server/composio_auth.py`: Composio integration module
  - Initialize Composio client with API key
  - `initiate_google_auth(user_id)` → returns redirect URL for OAuth consent
  - `get_auth_status(user_id)` → check if connected account is ACTIVE
  - `get_google_cookies(user_id)` → convert OAuth session to browser cookies (if feasible)
- [ ] `server/main.py`: Add OAuth endpoints
  - `POST /api/auth/google/initiate` → Start Composio OAuth flow, return redirect URL
  - `GET /api/auth/google/callback` → Handle OAuth callback
  - `GET /api/auth/google/status` → Check if Google account is linked
- [ ] `frontend/components/GoogleAuthButton.tsx`: OAuth linking UI
  - "Link Google Account" button (shown when no active connection)
  - Status indicator (linked / not linked)
  - Opens Composio OAuth redirect in popup/new tab
- [ ] Update `bridge/main.py` to check for Composio auth before falling back to persistent profile
- [ ] Add `COMPOSIO_API_KEY` to `.env.example` and `.env`

**Success criteria:** User authenticates Google account via Composio OAuth flow in the frontend. Bridge uses this authentication to join Meets.

**Files:**
```
server/composio_auth.py          — NEW: Composio OAuth management
server/main.py                   — Add auth endpoints
frontend/components/GoogleAuthButton.tsx — NEW: OAuth UI
.env.example                     — Add COMPOSIO_API_KEY
```

#### Phase 4: Polish and Hardening

**Goal:** Handle edge cases, improve reliability.

**Tasks:**

- [ ] Meet admission handling: Detect "waiting room" state, notify user via bridge status, 5-minute timeout
- [ ] Meeting end detection: Monitor for "meeting ended" DOM state, host kick, or all participants leaving
- [ ] Bridge crash recovery: Wrap bridge in supervisor logic, auto-restart once on crash, notify user
- [ ] Echo cancellation: Implement mute-during-TTS via LiveKit data channel signaling
- [ ] Speaker diarization: Enable Deepgram diarization on mixed audio stream for better speaker attribution
- [ ] Bot detection mitigation: Add stealth flags to Playwright launch (`--disable-blink-features=AutomationControlled`, remove `navigator.webdriver`)
- [ ] Resource limits: Track bridge subprocess memory/CPU, kill if exceeding limits
- [ ] Concurrent bridges: Limit to max 3 simultaneous bridges per server
- [ ] Error messages: User-friendly error strings for all failure points (invalid URL, auth failed, admission timeout, etc.)
- [ ] Cleanup on server shutdown: Kill all bridge subprocesses on SIGTERM/SIGINT

**Success criteria:** Bridge handles common failure cases gracefully with user-visible feedback.

## Acceptance Criteria

### Functional Requirements

- [ ] User can paste a Google Meet URL and trigger the agent to join that call
- [ ] Agent hears all Google Meet participants and can speak back into the call
- [ ] Agent facilitates the meeting (tangent detection, time warnings, interventions) same as in native mode
- [ ] Frontend shows bridge connection status in real-time
- [ ] Frontend shows live agenda progress during bridged meeting
- [ ] User can stop the bridge from the monitoring dashboard
- [ ] Bridge cleans up (leaves Meet, closes browser) when meeting ends or user stops it

### Non-Functional Requirements

- [ ] Bridge joins Google Meet within 30 seconds of user request
- [ ] End-to-end audio latency (Meet → Agent response → Meet) under 4 seconds
- [ ] Bridge handles meetings up to 2 hours without crashing
- [ ] Server handles at least 3 concurrent bridge sessions

### Quality Gates

- [ ] Manual end-to-end test: paste Meet link → agent joins → agent facilitates → meeting ends cleanly
- [ ] Echo test: verify agent does NOT respond to its own TTS output
- [ ] Failure test: invalid URL, denied admission, browser crash — all produce user-visible errors

## Dependencies & Prerequisites

| Dependency | Purpose | Action Needed |
|---|---|---|
| Playwright | Browser automation | `pip install playwright && playwright install chromium` |
| Composio SDK | Google OAuth | `pip install composio`, create account at composio.dev |
| Google bot account | Meet authentication (v1) | Create a dedicated Google account for the bot |
| LiveKit JS SDK (CDN) | In-browser audio bridging | None — loaded via CDN in bridge.js |
| Xvfb (Linux only) | Virtual display for headed Chrome | `apt install xvfb` (not needed on macOS) |

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Google blocks headless browser | Medium | Critical | Stealth flags, real Chrome (not Chromium), persistent profile |
| Meet UI changes break automation | High (long-term) | High | Isolate DOM selectors in `meet_automation.py`, use ARIA roles over CSS classes |
| RTCPeerConnection override doesn't capture Meet audio | Low | Critical | Fallback: tab audio capture via Chrome extension |
| Echo/feedback loop | Medium | High | Mute-during-TTS + transcript deduplication |
| OAuth-to-cookie conversion fails | Medium | High | Persistent browser profile as fallback (v1 default) |
| Bridge memory leak over long meetings | Medium | Medium | 2-hour timeout, resource monitoring, auto-restart |

## Open Questions (From SpecFlow Analysis)

These were identified during spec analysis. Defaults are provided — override during implementation if needed.

| # | Question | Default |
|---|---|---|
| Q1 | Auth strategy | Persistent browser profile for v1, Composio OAuth for v2 |
| Q2 | Audio capture method | In-browser JS injection (RTCPeerConnection override) |
| Q3 | Bot account ownership | Dedicated shared bot Google account |
| Q4 | User participation during bridge | User stays in Google Meet, frontend shows monitoring dashboard |
| Q5 | Meet admission handling | Frontend prompts user to admit bot, 5-min timeout |
| Q6 | Echo prevention | Mute capture during agent TTS |
| Q7 | Bridge status reporting | LiveKit data channel, topic `"bridge_status"` |
| Q8 | Concurrent bridges | Max 3 per server, ~500MB RAM each |
| Q9 | Speaker diarization | Deepgram diarization on mixed stream |

## Future Considerations

- **Google Calendar integration:** Use Composio to browse upcoming meetings and auto-join scheduled ones
- **Multi-platform support:** Same bridge pattern works for Zoom and Microsoft Teams
- **Chrome extension distribution:** Package the audio bridge as a Chrome extension for users to install, eliminating the headless browser entirely
- **LiveKit Egress recording:** Record the bridged meeting via LiveKit's built-in egress

## References & Research

### Internal References
- Brainstorm: [composio-google-meet-brainstorm.md](docs/brainstorms/2026-02-28-composio-google-meet-brainstorm.md)
- Agent entrypoint: [agent/main.py:37](agent/main.py#L37)
- Room creation: [server/main.py:149](server/main.py#L149)
- Room metadata parsing: [agent/main.py:48](agent/main.py#L48)
- Frontend room creation: [frontend/app/page.tsx:57](frontend/app/page.tsx#L57)
- Silent crash gotcha: [docs/solutions/runtime-errors/silent-agent-crash-elevenlabs-param-rename.md](docs/solutions/runtime-errors/silent-agent-crash-elevenlabs-param-rename.md)

### External References
- [Composio Python SDK — Authenticating Tools](https://docs.composio.dev/docs/authenticating-tools)
- [Composio Connected Accounts API](https://docs.composio.dev/docs/connected-accounts)
- [Playwright Python — Persistent Context](https://playwright.dev/python/docs/api/class-browsertype)
- [LiveKit JS SDK — publishTrack](https://docs.livekit.io/reference/client-sdk-js/classes/LocalParticipant.html)
- [puppeteer-stream (alternative approach)](https://github.com/SamuelScheit/puppeteer-stream)
- [Chrome tabCapture API](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)
