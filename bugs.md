# Bug Report — Beat Your Meet

_Generated: 2026-02-28_

---

## Critical Bugs (will break at runtime)

### 1. All speech attributed to first participant only
**File:** `agent/main.py:110`

```python
participant = await ctx.wait_for_participant()  # Only the first joiner

@session.on("user_input_transcribed")
def on_speech(event):
    speaker = participant.identity  # ← always this person, regardless of who spoke
    meeting_state.add_transcript(speaker, event.transcript)
```

In a multi-person meeting every transcript entry gets the first participant's identity. Monitoring prompts sent to Mistral will show only one "speaker" talking to themselves, degrading tangent detection quality significantly.

---

### 2. Invalid CORS config crashes newer Starlette at startup
**File:** `server/main.py:18-24`

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,  # ← INVALID with wildcard origin
    ...
)
```

The CORS spec forbids `Access-Control-Allow-Credentials: true` with a wildcard origin. Recent versions of Starlette raise a `ValueError` on startup for this combination, meaning the server never starts. `allow_credentials=True` should be removed since no frontend fetch uses `credentials: "include"`.

---

## High Priority (logic errors / silent failures)

### 3. `TANGENT_TOLERANCE` defined but never enforced
**File:** `agent/monitor.py:43-47`

```python
TANGENT_TOLERANCE = {
    "gentle": 60,
    "moderate": 30,
    "aggressive": 10,
}
```

This dict is declared but never read anywhere in the codebase. The agent always calls Mistral Small every 15 seconds regardless of style. The design intent (gentle = 60s tolerance before intervening, aggressive = 10s) is completely unimplemented — all three styles behave identically for tangent timing.

---

### 4. `lk_api.aclose()` not called on exception
**File:** `server/main.py:164-182`

```python
lk_api = api.LiveKitAPI(...)
await lk_api.room.create_room(...)  # if this throws...
await lk_api.aclose()               # ← never reached, leaks HTTP connections
```

Should use a `try/finally` block to guarantee cleanup.

---

### 5. `.env.example` key name mismatch for ElevenLabs
**File:** `.env.example:10`

`.env.example` defines `ELEVEN_API_KEY`, but `CLAUDE.md` documents the required key as `ELEVENLABS_API_KEY`. The livekit-plugins-elevenlabs plugin reads from the environment at init time; which name it uses depends on the installed version. This will silently result in unauthenticated TTS calls (API errors) rather than a clear startup failure.

---

## Medium Priority (performance & correctness)

### 6. Unused `now` state triggers 1-second re-renders
**File:** `frontend/components/AgendaDisplay.tsx:26-32`

```tsx
const [now, setNow] = useState(Date.now());

useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
}, []);
```

`now` is updated every second but is **never used in the render output**. The elapsed time displayed comes from `state.elapsed_minutes` from props (pushed by the agent every 15s). This causes one unnecessary re-render per second. Either remove the state and interval, or actually use `now` to compute a smoother live elapsed display interpolated between agent updates.

---

### 7. `asyncio.create_task` reference discarded
**File:** `agent/main.py:136`

```python
asyncio.create_task(_monitoring_loop(session, ctx, meeting_state))
```

The task is not stored anywhere. Python docs warn that tasks not held by a strong reference can be garbage collected mid-execution. The reference should be stored and optionally cancelled during cleanup.

---

### 8. Floating agenda panel flashes at `x: -1` on first render
**File:** `frontend/components/FloatingAgendaPanel.tsx:17`

```tsx
const [position, setPosition] = useState({ x: -1, y: 16 });

useEffect(() => {
    if (position.x === -1 && typeof window !== "undefined") {
        setPosition({ x: window.innerWidth - 336, y: 16 });
    }
}, [position.x]);
```

The panel renders at `left: -1px` for one paint cycle before the effect fires, causing a brief visual flicker at the far left edge. A lazy state initializer would fix this:
```tsx
useState(() =>
    typeof window !== "undefined"
        ? { x: window.innerWidth - 336, y: 16 }
        : { x: 0, y: 16 }
)
```

---

### 9. `agenda.total_minutes` not updated when items are edited
**File:** `frontend/components/AgendaEditor.tsx`

When a user edits item durations or adds/removes items, the `totalUsed` display correctly reflects the new total, but `agenda.total_minutes` retains the original AI-generated value. This field is sent to the server in `POST /api/room` and stored in LiveKit room metadata, so the stored total can be out of sync with actual item durations.

---

## Low Priority (type safety / developer experience)

### 10. `agendaState` typed as `any`
**File:** `frontend/app/room/[id]/page.tsx:117`

```tsx
const [agendaState, setAgendaState] = useState<any>(null);
```

The `AgendaState` interface is already defined in `AgendaDisplay.tsx`. Using `any` here loses all TypeScript safety for the most important piece of runtime state in the meeting room. The interface should be exported and used as `AgendaState | null`.

---

### 11. `NEXT_PUBLIC_LIVEKIT_URL` fallback is a non-functional placeholder
**File:** `frontend/app/room/[id]/page.tsx:25`

```tsx
const LIVEKIT_URL =
    process.env.NEXT_PUBLIC_LIVEKIT_URL || "wss://your-project.livekit.cloud";
```

If the env var is missing the app silently tries to connect to a non-existent host. A missing required env var should fail loudly rather than silently using a placeholder that produces a confusing connection error.

---

## Summary

| # | File | Severity | Issue |
|---|------|----------|-------|
| 1 | `agent/main.py:110` | Critical | All speech attributed to first participant only |
| 2 | `server/main.py:18` | Critical | `allow_credentials=True` + wildcard origin crashes Starlette |
| 3 | `agent/monitor.py:43` | High | `TANGENT_TOLERANCE` declared but never read or enforced |
| 4 | `server/main.py:170` | High | `lk_api.aclose()` skipped when `create_room` throws |
| 5 | `.env.example:10` | High | `ELEVEN_API_KEY` vs `ELEVENLABS_API_KEY` naming mismatch |
| 6 | `AgendaDisplay.tsx:26` | Medium | Unused `now` state causes 1 re-render/sec |
| 7 | `agent/main.py:136` | Medium | Task reference not stored, GC risk |
| 8 | `FloatingAgendaPanel.tsx:17` | Medium | Panel renders off-screen before position `useEffect` fires |
| 9 | `AgendaEditor.tsx` | Medium | `agenda.total_minutes` not updated when items change |
| 10 | `room/[id]/page.tsx:117` | Low | `agendaState: any` loses type safety |
| 11 | `room/[id]/page.tsx:25` | Low | LiveKit URL fallback is a non-functional placeholder |
