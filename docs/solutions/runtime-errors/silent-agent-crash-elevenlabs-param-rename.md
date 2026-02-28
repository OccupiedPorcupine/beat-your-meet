---
title: "Silent Agent Crash — ElevenLabs TTS Parameter Rename + Missing Error Handling"
date: 2026-02-28
category: runtime-errors
tags:
  - livekit-agents
  - elevenlabs
  - error-handling
  - environment-configuration
severity: critical
component:
  - agent/main.py
  - server/main.py
  - .env
symptoms:
  - "Frontend shows 'Waiting for meeting to start...' with only 1 participant"
  - "Agent process starts and registers with LiveKit but never joins rooms"
  - "No error logs visible — crash is completely silent"
root_cause_summary: "livekit-plugins-elevenlabs v1.4.3 renamed model_id to model, causing a TypeError swallowed by the livekit-agents subprocess framework"
---

# Silent Agent Crash — ElevenLabs TTS Parameter Rename

## Symptoms

- Frontend room page shows "Waiting for meeting to start..." indefinitely
- Participants list shows only 1 (the human user — no agent)
- Agent logs show `received job request` and `process initialized` but nothing after
- No error messages anywhere

## Root Cause

Two issues combined:

1. **Breaking API change**: `livekit-plugins-elevenlabs` v1.4.3 renamed the `TTS` constructor parameter from `model_id` to `model`. The code used `model_id`, causing a `TypeError`.

2. **Silent exception swallowing**: The `livekit-agents` framework runs the `entrypoint` function in a subprocess. Unhandled exceptions in the entrypoint are not surfaced to the parent process logs — they just silently kill the subprocess.

A secondary issue was `.env` having `NEXT_PUBLIC_LIVEKIT_URL=wss://your-project.livekit.cloud` (placeholder) instead of the real URL, so the frontend connected to a nonexistent server.

## Investigation

1. Checked agent logs — saw `process initialized` but no entrypoint logs after
2. Tested component imports individually in a Python script — `elevenlabs.TTS(model_id=...)` raised `TypeError`
3. Inspected `TTS.__init__` signature via `inspect.signature()` — confirmed param is `model` not `model_id`

Key debugging command that found the issue:
```python
python -c "
from livekit.plugins import elevenlabs
import inspect
print(inspect.signature(elevenlabs.TTS.__init__))
"
```

## Fix

### 1. ElevenLabs parameter rename (`agent/main.py`)

```python
# Before
tts=elevenlabs.TTS(model_id="eleven_turbo_v2_5")

# After
tts=elevenlabs.TTS(model="eleven_turbo_v2_5")
```

### 2. Entrypoint error handling (`agent/main.py`)

Wrapped the entire `entrypoint()` in try/except so crashes are always logged:

```python
async def entrypoint(ctx: JobContext):
    try:
        logger.info("Connecting to room...")
        await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
        # ... rest of initialization
        logger.info("Beat Your Meet agent started successfully")
    except Exception:
        logger.exception("Agent entrypoint crashed")
        raise
```

Added breadcrumb `logger.info()` calls at each stage (connecting, waiting for participant, parsing metadata, creating voice agent, starting session, starting monitoring loop) so you can see exactly where it fails.

### 3. Monitoring loop resilience (`agent/main.py`)

Wrapped each monitoring loop iteration and each `session.say()` call in individual try/except blocks so a single failure doesn't kill the loop:

```python
while True:
    await asyncio.sleep(check_interval)
    try:
        # ... check time, tangents, etc.
        try:
            await session.say(warning, allow_interruptions=True)
        except Exception:
            logger.exception("Failed to deliver time warning")
    except Exception:
        logger.exception("Monitoring loop iteration failed")
```

### 4. Server endpoint error handling (`server/main.py`)

All endpoints now catch and log errors with appropriate HTTP status codes:
- `KeyError` for missing env vars -> HTTP 500 with descriptive message
- `json.JSONDecodeError` for bad LLM output -> HTTP 502
- Generic exceptions -> HTTP 500/502 with logged traceback

### 5. Environment fix (`.env`)

```bash
# Before
NEXT_PUBLIC_LIVEKIT_URL=wss://your-project.livekit.cloud

# After
NEXT_PUBLIC_LIVEKIT_URL=wss://beat-the-meet-99fsjf10.livekit.cloud
```

## Prevention

- **Always wrap livekit-agents entrypoints in try/except** — the framework silently swallows subprocess exceptions
- **Pin plugin versions** in `requirements.txt` to avoid breaking API changes (e.g., `livekit-plugins-elevenlabs==1.4.3`)
- **Add breadcrumb logging** at each initialization stage so you can see where failures occur
- **Test component initialization** before running the full agent — a simple script that imports and constructs each component catches config errors fast

## Related

- [CLAUDE.md](../../../CLAUDE.md) — Architecture overview, development commands
- [README.md](../../../README.md) — Environment variables table, setup instructions
- [Implementation Plan](../../plans/2026-02-28-feat-ai-meeting-facilitator-bot-plan.md) — API patterns, dependencies
