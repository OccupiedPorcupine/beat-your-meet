# Plan: Mid-Meeting Style Adjustment

## Context

Beat's facilitation strictness (style: gentle / moderate / aggressive) is locked at room
creation time and cannot be changed once a meeting starts. This is limiting — a host may
want to tighten up the bot mid-meeting if conversations keep drifting, or ease off if the
team needs breathing room.

Style controls three real behaviours:

- **LLM tone** — via STYLE_INSTRUCTIONS injected into the system prompt (prompts.py:3-19)
- **Tangent intervention threshold** — _TANGENT_THRESHOLD in speech_gate.py:63 (0.80 / 0.70 / 0.60)
- **Intervention cooldown** — TANGENT_TOLERANCE in monitor.py:211 (60s / 30s / 10s)

The last two are already dynamic — both look up `state.style` / `ctx.style` at evaluation
time (confirmed: speech_gate.py:209, monitor.py:211). No changes are needed to those paths.
Only the system prompt needs an explicit refresh when the style changes mid-meeting.

---

## Implementation Plan

### 1. agent/main.py

**Refactor `_refresh_agent_instructions()`** — remove the `base_style_instructions`
parameter and derive it internally from `state.style`. This makes the function
self-contained and eliminates the need to thread a style string through callers:

```python
async def _refresh_agent_instructions(agent: Agent, state: MeetingState):
    ctx_data = state.get_context_for_prompt()
    new_instructions = FACILITATOR_SYSTEM_PROMPT.format(
        style_instructions=STYLE_INSTRUCTIONS.get(state.style, STYLE_INSTRUCTIONS["moderate"]),
        **ctx_data,
    )
    await agent.update_instructions(new_instructions)
    logger.info(f"Agent instructions refreshed (style={state.style})")
```

**Update all callers** — drop the `style_instructions` argument from both call sites:
- `entrypoint()` at line 172–176: remove the argument and remove the pre-computed
  `style_instructions` variable at line 193 since it is no longer needed.
- `_monitoring_loop()` at line 374: remove the argument.

**Update `_monitoring_loop()` signature** — remove the `style_instructions: str` parameter
and update the call to `_refresh_agent_instructions` inside it (covered above). Also remove
`style_instructions` from the `asyncio.create_task(...)` call at line 195.

**Add a `data_received` listener in `entrypoint()`** — register after the agent is created
(so the closure captures it) but before the monitoring loop starts:

```python
@ctx.room.on("data_received")
def on_data_received(data: rtc.DataPacket):
    # Any participant can change the style — intentionally open, not host-only.
    try:
        msg = json.loads(data.data.decode())
        if msg.get("type") == "set_style" and msg.get("style") in ("gentle", "moderate", "aggressive"):
            meeting_state.style = msg["style"]
            logger.info(f"Style changed to {msg['style']}")
            asyncio.create_task(_refresh_agent_instructions(agent, meeting_state))
    except Exception:
        logger.exception("Failed to handle data_received")
```

Notes on this handler:
- Uses `asyncio.create_task` (not `ensure_future`) to match the codebase convention
  (main.py:194).
- `json` and `asyncio` are already imported (main.py:8–9). No new imports needed.
- `data.data.decode()` is the correct API for `rtc.DataPacket` in livekit-rtc as bundled
  with livekit-agents>=0.8. Before implementing, verify with:
  `python -c "from livekit import rtc; help(rtc.DataPacket)"`
- Style changes are intentionally open to all participants (not host-only). If host-only
  control is needed later, `data.participant_identity` can be checked against the first
  joiner (`participant` variable, in scope at main.py:89).

**Update `_send_agenda_state()`** — include `"style"` in the payload so the frontend always
knows the current active style:

```python
"style": state.style,
```

---

### 2. frontend/components/AgendaDisplay.tsx

Add `style` to the `AgendaState` interface:

```typescript
export interface AgendaState {
  // ... existing fields ...
  style?: string;
}
```

---

### 3. frontend/components/FloatingAgendaPanel.tsx

**Architectural note:** The panel needs to publish a data message to the agent when the
style changes. Two approaches exist:
- **useRoomContext inside the panel** (chosen): self-contained, less prop-drilling.
  Works because `FloatingAgendaPanel` renders inside `<LiveKitRoom>` (confirmed:
  room/[id]/page.tsx tree is `LiveKitRoom → MeetingRoom → FloatingAgendaPanel`).
- **Callback prop from MeetingRoom**: keeps the panel decoupled from LiveKit,
  consistent with how `MeetingRoom` currently owns all LiveKit hooks. Would require
  adding `onStyleChange: (style: string) => void` to `FloatingAgendaPanelProps`.

The plan proceeds with `useRoomContext` for simplicity. Switch to the callback-prop
approach if `FloatingAgendaPanel` ever needs to be used outside a LiveKit context.

**Get the LiveKit room object:**

```typescript
import { useRoomContext } from "@livekit/components-react";
// inside the component:
const room = useRoomContext();
```

**Local state for optimistic UI** — initialise from `agendaState?.style ?? "moderate"`,
update immediately on click without waiting for the agent to echo back:

```typescript
const [activeStyle, setActiveStyle] = useState(agendaState?.style ?? "moderate");

useEffect(() => {
  if (agendaState?.style) setActiveStyle(agendaState.style);
}, [agendaState?.style]);
```

**Send message on style button click** — `publishData` returns a Promise; attach
`.catch(console.error)` so errors surface in dev tools rather than being silently swallowed:

```typescript
const handleStyleChange = (newStyle: string) => {
  setActiveStyle(newStyle);
  const payload = JSON.stringify({ type: "set_style", style: newStyle });
  room.localParticipant
    .publishData(new TextEncoder().encode(payload), { reliable: true })
    .catch(console.error);
};
```

**Render three style buttons** in the panel body, above the agenda list:

```tsx
<div className="px-3 py-2 border-b border-gray-800 flex gap-2">
  {(["gentle", "moderate", "aggressive"] as const).map((s) => (
    <button
      key={s}
      onClick={() => handleStyleChange(s)}
      className={`flex-1 text-xs py-1 rounded transition-colors capitalize ${
        activeStyle === s
          ? "bg-blue-600 text-white"
          : "bg-gray-800 text-gray-400 hover:bg-gray-700"
      }`}
    >
      {s}
    </button>
  ))}
</div>
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `agent/main.py` | Refactor `_refresh_agent_instructions()`, remove `style_instructions` param from `_monitoring_loop()` and its call site, add `data_received` handler, add `style` to `_send_agenda_state()` |
| `frontend/components/AgendaDisplay.tsx` | Add `style?: string` to `AgendaState` |
| `frontend/components/FloatingAgendaPanel.tsx` | Add `useRoomContext`, style state, `handleStyleChange`, style buttons |

No changes needed to `server/main.py`, `monitor.py`, `prompts.py`, or `speech_gate.py` —
those already read `state.style` dynamically.

---

## Verification

1. Start all three services. Create a meeting with `moderate` style. Confirm the floating
   panel shows three style buttons with `moderate` highlighted.

2. Click `aggressive` mid-meeting. Check agent logs for:
   - `"Style changed to aggressive"`
   - `"Agent instructions refreshed (style=aggressive)"`

3. Verify behaviour change — speak off-topic. With `gentle` the bot should wait 60s before
   intervening (TANGENT_TOLERANCE); with `aggressive` it should intervene within 10s.

4. Confirm state echoes back — after the next 15s monitoring tick, the `_send_agenda_state`
   payload should carry `"style": "aggressive"`, and the button in the panel should still
   show the correct highlight (optimistic state should already match).

5. Edge case — rapid clicks — clicking multiple styles quickly should not crash. Each fires
   `asyncio.create_task`; the last one to complete wins since `state.style` is a plain
   string field with no locking needed.

6. Before implementation: verify `rtc.DataPacket.data` is the correct bytes attribute for
   the installed livekit-rtc version:
   `python -c "from livekit import rtc; help(rtc.DataPacket)"`
