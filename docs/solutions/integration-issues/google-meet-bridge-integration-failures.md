---
title: "Google Meet Bridge Integration Failures"
date: 2026-02-28
category: integration-issues
tags:
  - ElevenLabs TTS
  - Google Meet Bridge
  - Content Security Policy
  - Playwright
  - Subprocess Management
  - LiveKit SDK
component:
  - agent
  - server
  - bridge
severity: High
symptoms:
  - "Agent TTS fails with 'no audio frames were pushed for text' on every call"
  - "Bridge subprocess exits immediately with code 1"
  - "Bridge crashes with 'Failed to set the src property on HTMLScriptElement: TrustedScriptURL'"
  - "Frontend shows 'Disconnected' seconds after bridge starts"
related_issues: []
---

# Google Meet Bridge Integration Failures

Multiple issues prevented the Google Meet bridge from working end-to-end. This document covers the diagnosis and fix for each.

## Problem 1: ElevenLabs TTS 401 — Invalid API Key

### Symptoms

The agent logged repeated warnings then errors:

```
failed to synthesize speech: no audio frames were pushed for text: Hi everyone...
```

Every `session.say()` call failed. The agent started but could never speak.

### Root Cause

The ElevenLabs API key in `.env` was expired/invalid, returning HTTP 401. The livekit-plugins-elevenlabs plugin reads `ELEVEN_API_KEY` (not `ELEVENLABS_API_KEY`). When the API rejects the key, the streaming WebSocket connects but returns no audio data — surfacing as the confusing "no audio frames" error rather than a clear auth failure.

### Diagnosis

```bash
curl -s -w "\nHTTP_STATUS: %{http_code}" \
  "https://api.elevenlabs.io/v1/text-to-speech/bIHbv24MWmeRgasZH58o" \
  -H "xi-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello","model_id":"eleven_turbo_v2_5"}' \
  -o /dev/null
```

If this returns `HTTP_STATUS: 401`, the key is invalid.

### Solution

Regenerate the API key from the ElevenLabs dashboard and update `.env`:

```env
ELEVEN_API_KEY=sk_your_new_key_here
```

---

## Problem 2: Bridge Subprocess Using Wrong Python

### Symptoms

Server spawned bridge, but it exited immediately with code 1. No visible error output (stdout/stderr were piped). The bridge status endpoint returned `{"status": "DISCONNECTED", "exit_code": 1}`.

### Root Cause

`server/main.py` used bare `"python"` to spawn the bridge subprocess. The bridge's dependencies (playwright, livekit) are installed in `bridge/.venv`, not the system Python.

### Solution

Resolve the venv Python path before spawning:

```python
# server/main.py
bridge_dir = os.path.join(os.path.dirname(__file__), "..", "bridge")
bridge_script = os.path.join(bridge_dir, "main.py")
bridge_python = os.path.join(bridge_dir, ".venv", "bin", "python")
if not os.path.exists(bridge_python):
    bridge_python = "python"  # fallback
process = subprocess.Popen([bridge_python, bridge_script, ...])
```

---

## Problem 3: Google Meet Trusted Types CSP Blocks Script Injection

### Symptoms

Bridge joined Google Meet successfully but crashed instantly when injecting `bridge.js`:

```
TypeError: Failed to set the 'src' property on 'HTMLScriptElement':
This document requires 'TrustedScriptURL' assignment.
```

### Root Cause

Google Meet enforces a [Trusted Types CSP](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API) policy. This blocks JavaScript from setting `script.src = "..."` dynamically. The original `bridge.js` loaded the LiveKit SDK via:

```javascript
const script = document.createElement("script");
script.src = "https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.js";
// ^^^ Blocked by Trusted Types
```

### What Didn't Work

- Chrome flag `--disable-features=TrustedDOMTypes,TrustedScriptURL` — not valid feature names
- Playwright `bypass_csp=True` — bypasses standard CSP but not Trusted Types enforcement in newer Chrome

### Solution

Use Playwright's `page.add_script_tag()` which operates via Chrome DevTools Protocol (CDP), bypassing page-level CSP entirely:

```python
# bridge/main.py — load SDK via CDP
await page.add_script_tag(
    url="https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.js"
)
await page.wait_for_function(
    "typeof window.LivekitClient !== 'undefined'", timeout=10000
)

# Inject bridge.js via CDP too
await page.add_script_tag(content=bridge_js_source)
```

Update `bridge.js` to expect the SDK already loaded:

```javascript
// bridge.js — SDK is pre-loaded by Playwright
const LivekitClient = window.LivekitClient;
if (!LivekitClient) {
  console.error("[Bridge] LiveKit SDK not found on window");
  return;
}
```

---

## Problem 4: No Retry Mechanism for Failed Bridge

### Symptoms

When the bridge crashed, the frontend showed "Disconnected" with no way to recover without starting over from the home page.

### Solution

Added:

- **Server**: `POST /api/bridge-restart/{room_name}` endpoint that kills the old process and spawns a new one using the stored Meet URL
- **Frontend**: "Reconnect Bridge" button visible when status is `DISCONNECTED`, calls the restart endpoint

---

## Prevention Strategies

### Early API Key Validation

Validate all API keys at startup with lightweight calls before entering the main loop. A health check endpoint (`/api/health-detailed`) that tests each key would catch auth issues immediately.

### Subprocess Environment Safety

- Always resolve venv Python paths explicitly rather than relying on system `python`
- Log the interpreter path before spawning: `logger.info(f"Using Python: {bridge_python}")`
- Consider failing fast instead of falling back to system Python when venv is missing

### CSP-Aware Script Injection

When injecting scripts into third-party pages (Google Meet, etc.), always use Playwright's CDP-level injection (`add_script_tag`) rather than in-page JavaScript (`document.createElement`). Third-party pages may enforce strict CSP policies.

### Bridge Resilience

- Log bridge subprocess stderr to a file for debugging (don't just pipe to nowhere)
- Implement automatic retry with backoff on bridge failures
- Add a heartbeat mechanism so the server can detect silent bridge deaths

---

## Cross-References

- [CLAUDE.md](../../../CLAUDE.md) — Project architecture overview
- [bridge/README.md](../../../bridge/README.md) — Bridge setup and known limitations
- [docs/solutions/runtime-errors/silent-agent-crash-elevenlabs-param-rename.md](../runtime-errors/silent-agent-crash-elevenlabs-param-rename.md) — Related ElevenLabs debugging
- [docs/plans/2026-02-28-feat-google-meet-bridge-composio-plan.md](../../plans/2026-02-28-feat-google-meet-bridge-composio-plan.md) — Original bridge implementation plan
