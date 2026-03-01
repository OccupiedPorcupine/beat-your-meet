# Agent Participation Implementation Code Examples

## Phase 1: Explicit Agent Invite (Low Effort)

### 1.1 Server: New Invite Endpoint

**File:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/server/main.py`

Add this after the `/api/room` endpoint (after line 220):

```python
# ── Agent Management ──────────────────────────────────────────────


class AgentInviteRequest(BaseModel):
    room_name: str


@app.post("/api/agent/invite")
async def invite_agent(req: AgentInviteRequest):
    """Explicitly dispatch agent to an existing room.

    This triggers the LiveKit worker dispatch system to send a job
    to the Beat Your Meet agent worker. The worker will call entrypoint()
    which connects the agent to the room.
    """
    try:
        lk_api = api.LiveKitAPI(
            os.environ["LIVEKIT_URL"],
            os.environ["LIVEKIT_API_KEY"],
            os.environ["LIVEKIT_API_SECRET"],
        )
        try:
            # 1. Verify room exists
            rooms = await lk_api.room.list_rooms(
                api.ListRoomsRequest(names=[req.room_name])
            )
            if not rooms.rooms:
                raise HTTPException(status_code=404, detail="Room not found")

            # 2. Get room metadata to verify it has an agenda
            room_metadata = json.loads(rooms.rooms[0].metadata or "{}")
            if "agenda" not in room_metadata:
                raise HTTPException(
                    status_code=400,
                    detail="Room has no agenda configured"
                )

            # 3. Create dispatch request to agent worker
            # Note: This assumes LiveKit has an agent dispatch service configured
            # See: https://docs.livekit.io/agents/deployment/
            from livekit.api import AgentDispatchService

            dispatch_svc = AgentDispatchService(lk_api)
            await dispatch_svc.create(
                api.CreateAgentDispatchRequest(
                    room=req.room_name,
                    # Agent name should match the agent's configuration
                    agent=os.environ.get("AGENT_WORKER_NAME", "beat-facilitator"),
                )
            )

            logger.info(f"Agent dispatch created for room: {req.room_name}")
            return {"status": "invited", "room_name": req.room_name}

        finally:
            await lk_api.aclose()

    except HTTPException:
        raise
    except KeyError as e:
        logger.error(f"Missing env var for agent invite: {e}")
        raise HTTPException(status_code=500, detail=f"Server misconfigured: missing {e}")
    except Exception as e:
        logger.exception("Agent invite failed")
        raise HTTPException(status_code=502, detail=f"Failed to invite agent: {e}")
```

**Environment variable to add to `.env`:**
```bash
AGENT_WORKER_NAME=beat-facilitator
```

---

### 1.2 Frontend: Invite Button on Setup

**File:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/frontend/app/page.tsx`

Add an "Invite Agent" checkbox or toggle to the CreateRoomRequest:

```typescript
// In the component where user selects style and creates room

const [inviteAgent, setInviteAgent] = useState(true);  // Enabled by default

async function handleCreateMeeting() {
  try {
    // ... existing room creation code ...
    const roomRes = await fetch(`${SERVER_URL}/api/room`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agenda: finalizedAgenda,
        style: selectedStyle,
      }),
    });

    if (!roomRes.ok) {
      throw new Error("Failed to create room");
    }

    const roomData = await roomRes.json();
    const roomName = roomData.room_name;

    // NEW: If user enabled agent, explicitly invite it
    if (inviteAgent) {
      try {
        const inviteRes = await fetch(`${SERVER_URL}/api/agent/invite`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room_name: roomName }),
        });

        if (!inviteRes.ok) {
          console.warn("Failed to invite agent, but continuing:", inviteRes.status);
          // Agent invite failure should not block meeting creation
        } else {
          logger.info("Agent invited successfully");
        }
      } catch (err) {
        console.warn("Agent invite error:", err);
      }
    }

    // Navigate to room
    router.push(`/room/${roomName}?code=${roomData.access_code}`);

  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

// In the JSX, add a checkbox before "Create Meeting":
<label className="flex items-center gap-2 mb-4">
  <input
    type="checkbox"
    checked={inviteAgent}
    onChange={(e) => setInviteAgent(e.target.checked)}
    className="w-4 h-4 rounded border-gray-500"
  />
  <span className="text-sm text-gray-300">Invite Beat AI facilitator</span>
</label>
```

---

## Phase 2: Agent Removal (Medium Effort)

### 2.1 Server: Remove Endpoint

**File:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/server/main.py`

Add this after the `/api/agent/invite` endpoint:

```python
class AgentRemoveRequest(BaseModel):
    room_name: str


@app.post("/api/agent/remove")
async def remove_agent(req: AgentRemoveRequest):
    """Signal agent to leave a room.

    Sends a graceful exit signal via LiveKit data channel.
    The agent's on_data_received handler will receive this and
    break the monitoring loop, allowing it to exit naturally.
    """
    try:
        lk_api = api.LiveKitAPI(
            os.environ["LIVEKIT_URL"],
            os.environ["LIVEKIT_API_KEY"],
            os.environ["LIVEKIT_API_SECRET"],
        )
        try:
            # 1. Verify room exists
            rooms = await lk_api.room.list_rooms(
                api.ListRoomsRequest(names=[req.room_name])
            )
            if not rooms.rooms:
                raise HTTPException(status_code=404, detail="Room not found")

            # 2. Send exit signal via data channel
            # Note: This requires accessing the room's data channel,
            # which is only available through the LiveKit agent or client SDK.
            # We have a few options:

            # OPTION A: Use the Room object from a connected client
            # (This requires the server to maintain a room connection,
            #  which the current design doesn't do)

            # OPTION B: Remove participant via LiveKit API directly
            # Find the agent participant and remove it
            room = rooms.rooms[0]
            participants = await lk_api.room.list_participants(
                api.ListParticipantsRequest(room=req.room_name)
            )

            agent_participant = None
            for p in participants.participants:
                # Agent is identified by kind or identity pattern
                if (p.identity.startswith("agent-") or
                    "bot" in p.identity.lower()):
                    agent_participant = p
                    break

            if agent_participant:
                # Remove the agent participant from the room
                await lk_api.room.remove_participant(
                    api.RemoveParticipantRequest(
                        room=req.room_name,
                        identity=agent_participant.identity
                    )
                )
                logger.info(f"Agent removed from room: {req.room_name}")
            else:
                # Agent not currently in room
                logger.warning(f"Agent not found in room: {req.room_name}")

            return {"status": "removed", "room_name": req.room_name}

        finally:
            await lk_api.aclose()

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Agent removal failed")
        raise HTTPException(status_code=502, detail=f"Failed to remove agent: {e}")
```

**Alternative Approach (Graceful Exit via Data Channel):**

If you want the agent to exit gracefully instead of being forcefully removed, you need the agent to be listening. This requires modifying the agent, but it allows for cleaner shutdown.

```python
# Alternative for /api/agent/remove (graceful exit)
# Requires the agent to be modified to handle "agent_exit" message

@app.post("/api/agent/remove")
async def remove_agent(req: AgentRemoveRequest):
    """Signal agent to exit gracefully."""
    try:
        lk_api = api.LiveKitAPI(...)

        # Instead of removing via API, we'd send a data channel message
        # This requires the server to have a room connection,
        # OR it requires the agent to expose an HTTP endpoint for exit signals

        # For now, using the API removal is simpler and more reliable
        # The graceful exit approach is better suited for Phase 3

        raise HTTPException(
            status_code=501,
            detail="Graceful exit requires agent modification. Use API removal instead."
        )

    except Exception as e:
        logger.exception("Agent removal failed")
        raise HTTPException(status_code=502, detail=str(e))
```

---

### 2.2 Agent: Handle Exit Signal (with API removal)

For API removal, the agent doesn't need changes (it's automatically disconnected).

But if you want to implement graceful exit in Phase 3, add this to the agent:

**File:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/agent/main.py`

In the `on_data_received` handler (around line 488), add:

```python
@ctx.room.on("data_received")
def on_data_received(data: rtc.DataPacket):
    try:
        msg = json.loads(data.data.decode())

        # EXISTING CODE HERE (style change, chat mentions, etc.)
        # ... existing handlers ...

        # NEW: Handle agent exit signal (Phase 3)
        elif msg.get("type") == "agent_exit":
            reason = msg.get("reason", "unknown")
            logger.info(f"Graceful exit requested (reason: {reason})")
            # Signal monitoring loop to exit
            state.force_exit = True  # Add this flag to MeetingState

        # NEW: Handle agent pause signal (Phase 3)
        elif msg.get("type") == "agent_pause":
            logger.info("Agent paused")
            state.paused = True  # Add this flag to MeetingState
            # monitoring_loop will check this and sleep instead of processing

        # NEW: Handle agent resume signal (Phase 3)
        elif msg.get("type") == "agent_resume":
            logger.info("Agent resumed")
            state.paused = False  # Resume processing

    except Exception:
        logger.exception("Failed to handle data_received")
```

Then modify the monitoring loop to check for exit flag:

```python
async def _monitoring_loop(
    session: AgentSession,
    ctx: JobContext,
    state: MeetingState,
    agent: Agent,
):
    """Periodically check if conversation is on-track and handle time transitions."""

    while True:
        await asyncio.sleep(check_interval)

        # NEW: Check for force exit signal (Phase 3)
        if getattr(state, 'force_exit', False):
            logger.info("Monitoring loop exiting due to force_exit signal")
            break

        # NEW: Skip processing if paused (Phase 3)
        if getattr(state, 'paused', False):
            logger.debug("Monitoring loop paused, skipping checks")
            await _send_agenda_state(ctx.room, state)
            continue

        # EXISTING LOGIC HERE
        # ... rest of monitoring loop ...
```

---

### 2.3 Frontend: Remove Button in Participant Tile

**File:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/frontend/components/SmartParticipantTile.tsx`

Modify the bot tile section to add a remove button (around line 60):

```typescript
if (isBotParticipant) {
  const onRemoveAgent = async () => {
    if (confirm("Remove the AI facilitator from this meeting?")) {
      try {
        const roomName = useRoomContext?.()?.room?.name;
        if (!roomName) return;

        const res = await fetch(
          `${process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:8000"}/api/agent/remove`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ room_name: roomName }),
          }
        );

        if (!res.ok) {
          alert(`Failed to remove agent: ${res.statusText}`);
        }
        // Agent will disappear from participant list automatically
      } catch (error) {
        alert(`Error removing agent: ${error}`);
      }
    }
  };

  return (
    <div
      {...elementProps}
      className={`lk-participant-tile bot-tile ${elementProps.className || ""} relative`}
    >
      {/* Remove button (only for host/permission) */}
      <button
        onClick={onRemoveAgent}
        className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm opacity-0 group-hover:opacity-100 transition-opacity"
        title="Remove agent from meeting"
      >
        ✕
      </button>

      <TrackRefContextIfNeeded trackRef={trackRef}>
        <ParticipantContextIfNeeded participant={participant}>
          <div className="flex flex-col items-center justify-center w-full h-full gap-3">
            {/* Bot avatar SVG - unchanged */}
            <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
              {/* ... SVG code ... */}
            </svg>
            <ParticipantName className="text-sm text-gray-300 font-medium" />
          </div>
        </ParticipantContextIfNeeded>
      </TrackRefContextIfNeeded>
    </div>
  );
}
```

---

## Phase 3: Advanced Features (Optional)

### 3.1 Agent Pause/Resume Endpoints

**File:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/server/main.py`

```python
class AgentPauseRequest(BaseModel):
    room_name: str


class AgentResumeRequest(BaseModel):
    room_name: str


@app.post("/api/agent/pause")
async def pause_agent(req: AgentPauseRequest):
    """Pause agent monitoring without exiting the room.

    Requires agent modification to handle "agent_pause" data channel message.
    """
    try:
        lk_api = api.LiveKitAPI(...)
        # Send pause signal via data channel
        # Same challenge as graceful exit — need agent connection or HTTP endpoint
        raise HTTPException(
            status_code=501,
            detail="Pause feature requires agent modifications"
        )
    except Exception as e:
        logger.exception("Agent pause failed")
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/agent/resume")
async def resume_agent(req: AgentResumeRequest):
    """Resume agent monitoring from paused state."""
    try:
        lk_api = api.LiveKitAPI(...)
        # Send resume signal via data channel
        raise HTTPException(
            status_code=501,
            detail="Resume feature requires agent modifications"
        )
    except Exception as e:
        logger.exception("Agent resume failed")
        raise HTTPException(status_code=502, detail=str(e))
```

---

### 3.2 Frontend State Machine for Agent Status

**File:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/frontend/app/room/[id]/page.tsx`

Add agent state tracking:

```typescript
type AgentState = 'absent' | 'invited' | 'active' | 'paused' | 'removed';

function RoomPageInner() {
  // ... existing state ...

  const [agentState, setAgentState] = useState<AgentState>('absent');
  const room = useRoomContext?.()?.room;
  const tracks = useTracks();

  // Track agent presence
  useEffect(() => {
    const participants = tracks
      .map(t => t.participant)
      .filter(p => p && isBot(p));

    const agentPresent = participants.length > 0;

    setAgentState(prev => {
      if (agentPresent && prev === 'invited') {
        return 'active';  // Transitioned from invited to active
      }
      if (!agentPresent && (prev === 'active' || prev === 'paused')) {
        return 'removed';  // Agent left or was removed
      }
      return prev;
    });
  }, [tracks]);

  // Invite agent button
  const handleInviteAgent = async () => {
    if (!room) return;
    setAgentState('invited');

    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:8000"}/api/agent/invite`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room_name: room.name }),
        }
      );

      if (!res.ok) {
        alert("Failed to invite agent");
        setAgentState('absent');
      }
    } catch (error) {
      alert(`Error inviting agent: ${error}`);
      setAgentState('absent');
    }
  };

  // Pause agent button
  const handlePauseAgent = async () => {
    if (!room) return;
    setAgentState('paused');

    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:8000"}/api/agent/pause`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room_name: room.name }),
        }
      );

      if (!res.ok) {
        setAgentState('active');
      }
    } catch (error) {
      alert(`Error pausing agent: ${error}`);
      setAgentState('active');
    }
  };

  // Render agent controls based on state
  const renderAgentControls = () => {
    switch (agentState) {
      case 'absent':
        return <button onClick={handleInviteAgent}>Invite Agent</button>;
      case 'invited':
        return <button disabled>Inviting agent...</button>;
      case 'active':
        return (
          <>
            <button onClick={handlePauseAgent}>Pause Agent</button>
            <button onClick={handleRemoveAgent}>Remove Agent</button>
          </>
        );
      case 'paused':
        return (
          <>
            <button onClick={handleResumeAgent}>Resume Agent</button>
            <button onClick={handleRemoveAgent}>Remove Agent</button>
          </>
        );
      case 'removed':
        return <button onClick={handleInviteAgent}>Invite Agent Again</button>;
    }
  };

  return (
    // ... existing JSX ...
    <div className="agent-controls">
      {renderAgentControls()}
    </div>
  );
}
```

---

## Testing Phase 1 + 2 Implementation

### Manual Test Script

```bash
#!/bin/bash

# Start services (in separate terminals)
# Terminal 1:
cd /Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/frontend
npm run dev

# Terminal 2:
cd /Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/server
python main.py

# Terminal 3:
cd /Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/agent
python main.py start


# Test Phase 1: Invite Agent
echo "=== Testing Agent Invite ==="
curl -X POST http://localhost:8000/api/agent/invite \
  -H "Content-Type: application/json" \
  -d '{"room_name": "test-room-123"}'

# Test Phase 2: Remove Agent
echo "=== Testing Agent Remove ==="
curl -X POST http://localhost:8000/api/agent/remove \
  -H "Content-Type: application/json" \
  -d '{"room_name": "test-room-123"}'
```

### Frontend Test Checklist

- [ ] Create a meeting with agent enabled → Agent appears in participant list
- [ ] Remove agent via button → Agent disappears from participant list
- [ ] Invite agent again → Agent reappears in participant list
- [ ] Remove agent mid-conversation → Agent stops responding, leaves room
- [ ] Verify agent status indicator shows "Paused" (Phase 3)
- [ ] Pause agent → Agent stops monitoring but stays in room (Phase 3)
- [ ] Resume agent → Agent resumes monitoring (Phase 3)

---

## Integration Checklist

### Phase 1 (Explicit Invite)
- [ ] Add `/api/agent/invite` endpoint to server
- [ ] Add `AGENT_WORKER_NAME` to `.env`
- [ ] Add "Invite Agent" toggle to home page
- [ ] Test invite flow end-to-end
- [ ] Verify agent joins after invite

### Phase 2 (Remove)
- [ ] Add `/api/agent/remove` endpoint to server
- [ ] Add remove button to agent tile in SmartParticipantTile.tsx
- [ ] Update SmartParticipantTile to use useRoomContext for room name
- [ ] Test remove flow: button click → agent leaves → UI updates
- [ ] Verify agent appears/disappears correctly in participant list

### Phase 3 (Pause/Resume)
- [ ] Add `force_exit`, `paused` flags to MeetingState
- [ ] Add pause/resume endpoints to server
- [ ] Modify monitoring loop to check pause flag
- [ ] Add "agent_pause" and "agent_resume" message handlers in agent
- [ ] Implement state machine in frontend (absent → invited → active → paused → removed)
- [ ] Add pause/resume buttons to UI
- [ ] Test pause: monitoring stops, agent stays in room
- [ ] Test resume: monitoring resumes from pause point

---

## Notes on Data Channel Alternative

The current implementation uses LiveKit API removal for simplicity (Phase 2).

For a cleaner graceful shutdown, you could have the server send data channel messages to the agent, but this requires:

1. Server maintaining a room connection OR
2. Agent exposing an HTTP endpoint for control signals OR
3. Using a pub/sub system (Redis) to signal the agent

The API removal approach is simpler and more reliable for Phase 2. Graceful shutdown can be added later in Phase 3 if needed.

---

## Environment Variables Summary

Add to `.env`:

```bash
# Existing
LIVEKIT_URL=...
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
MISTRAL_API_KEY=...
DEEPGRAM_API_KEY=...
ELEVEN_API_KEY=...

# New for agent invite/remove
AGENT_WORKER_NAME=beat-facilitator
AGENT_IDENTITY=beat-facilitator  # Optional: set explicit agent name
```

---

## Summary

**Phase 1 + 2 Implementation:**
- Server: ~60 lines of code (2 endpoints)
- Agent: ~0 lines (no changes for API removal)
- Frontend: ~100 lines (button + state management)
- **Total effort:** ~4–8 hours
- **Result:** Users can explicitly invite and remove agent mid-meeting

**Phase 3 (Optional):**
- Server: ~40 lines (2 more endpoints)
- Agent: ~30 lines (state flags, message handlers)
- Frontend: ~100 lines (state machine, UI buttons)
- **Total effort:** ~8–12 hours
- **Result:** Full lifecycle control (invite, pause, resume, remove)

**Recommendation:** Implement Phase 1 + 2 first. Phase 3 can be added later if users request pause/resume functionality.
