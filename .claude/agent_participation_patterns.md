# Agent Participation Pattern Research
## Making the Bot a Real Participant That Can Be Invited or Removed

**Research Date:** 2026-03-01
**Focus:** Understanding how the agent currently joins rooms and patterns for making it a real, controllable participant

---

## Executive Summary

Beat Your Meet uses the **LiveKit Agents Framework** for autonomous agent deployment. The agent currently joins rooms via **worker dispatch** (automatic job assignment by LiveKit) rather than as an explicit user-invitable participant. To make the agent a "real participant" that users can invite or remove, significant architectural changes are needed.

**Current Model:** Worker dispatch (push) → **Proposed Model:** Explicit agent join/exit (pull + lifecycle control)

---

## Part 1: How the Agent Currently Joins Rooms

### 1.1 Worker Dispatch Architecture

The agent uses LiveKit's **Worker Options with entrypoint functions**:

**File:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/agent/main.py` (lines 961–971)

```python
if __name__ == "__main__":
    agent_port = _resolve_agent_port()
    if _is_port_in_use(agent_port):
        logger.error(...)
        sys.exit(1)

    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, port=agent_port))
```

**How it works:**
1. Agent service starts as a **worker** listening on a port (default 8081)
2. LiveKit server automatically dispatches jobs to this worker when:
   - A room is created with agent-compatible metadata, OR
   - An explicit dispatch request is made via LiveKit API
3. The `entrypoint(ctx: JobContext)` function is called for each dispatch
4. **Agent joins automatically** — not triggered by user action

### 1.2 Entrypoint Function (The Job Handler)

**File:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/agent/main.py` (lines 388–561)

```python
async def entrypoint(ctx: JobContext):
    try:
        logger.info("Connecting to room...")
        await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

        # Wait for the first human participant to join
        logger.info("Waiting for participant...")
        participant = await ctx.wait_for_participant()
        logger.info(f"Participant joined: {participant.identity}")

        # Parse room metadata for agenda and style
        logger.info("Parsing room metadata...")
        room_metadata = ctx.room.metadata
        if room_metadata:
            metadata = json.loads(room_metadata)
        else:
            # Fallback: default agenda
            metadata = {...}

        # Initialize meeting state and agent
        meeting_state = MeetingState.from_metadata(metadata)
        agent = BeatFacilitatorAgent(...)

        session = AgentSession()
        await session.start(agent, room=ctx.room)

        # Start meeting and monitoring loop
        meeting_state.start_meeting()
        _monitor_task = asyncio.create_task(
            _monitoring_loop(session, ctx, meeting_state, agent)
        )

    except Exception:
        logger.exception("Agent entrypoint crashed")
        raise
```

**Key Flow:**
1. `ctx.connect()` — automatically joins the room assigned by dispatcher
2. `ctx.wait_for_participant()` — blocks until a human joins (simple gating)
3. `ctx.room` — provides access to the LiveKit room instance
4. Agent stays until **monitoring loop breaks** (when all agenda items complete)

### 1.3 Agent Lifecycle (Implicit)

**Entry:** LiveKit worker dispatch → automatic job assignment
**Exit:** Monitoring loop completes → session ends → connection closes
**No explicit:** pause/resume, invite mechanism, or user-controlled removal

---

## Part 2: How Rooms Are Created and Managed

### 2.1 Room Creation Flow

**File:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/server/main.py` (lines 181–220)

```python
@app.post("/api/room")
async def create_room(req: CreateRoomRequest):
    import uuid

    room_name = f"meet-{uuid.uuid4().hex[:8]}"
    access_code = generate_access_code()

    # Store room metadata (agenda + style + access code)
    room_metadata = json.dumps({
        "agenda": req.agenda,
        "style": req.style,
        "access_code": access_code,
    })

    try:
        lk_api = api.LiveKitAPI(...)
        await lk_api.room.create_room(
            api.CreateRoomRequest(
                name=room_name,
                metadata=room_metadata,
            )
        )
    finally:
        await lk_api.aclose()

    return {"room_name": room_name, "access_code": access_code}
```

**Key observations:**
- Room metadata contains `agenda`, `style`, and `access_code` (no agent dispatch fields)
- Room is created **passively** — no explicit agent dispatch call
- Agent dispatcher would need to be configured separately to watch for rooms with agent markers

### 2.2 Agent Discovery Mechanism (Not Yet Implemented)

**Current assumption:** Agent dispatcher is configured at LiveKit server level to auto-dispatch to all rooms
**Alternative:** Use LiveKit API to explicitly dispatch agent to room (requires server API call)

**To make dispatch explicit, server would need to:**
```python
# Pseudocode: explicit dispatch
dispatch_service = api.AgentDispatchService(...)
await dispatch_service.create(api.CreateAgentDispatchRequest(
    room=room_name,
    agent=agent_name,  # or worker identifier
))
```

---

## Part 3: Frontend Interaction with Agent Presence

### 3.1 Agent Detection in UI

**File:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/frontend/components/SmartParticipantTile.tsx` (lines 31–36)

```typescript
function isBot(participant: { kind?: unknown; identity: string }): boolean {
  if (participant.kind === ParticipantKind.AGENT) return true;
  return (
    participant.identity.startsWith("agent-") ||
    participant.identity.toLowerCase().includes("bot")
  );
}
```

**Agent Detection Methods:**
1. Check `ParticipantKind.AGENT` (LiveKit's enum, set when agent joins)
2. Check identity string patterns: `"agent-*"` or `"*bot*"`
3. Renders special bot avatar instead of human avatar

### 3.2 Participant Display

**File:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/frontend/components/SmartParticipantTile.tsx` (lines 60–112)

```typescript
if (isBotParticipant) {
  return (
    <div className="lk-participant-tile bot-tile">
      <div className="flex flex-col items-center justify-center w-full h-full gap-3">
        {/* Bot avatar SVG — blue robot icon */}
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
          {/* Blue robot with antenna and smile */}
        </svg>
        <ParticipantName className="text-sm text-gray-300 font-medium" />
      </div>
    </div>
  );
}
```

**Current Display:**
- Custom bot avatar (blue robot with antenna)
- Participant name from LiveKit identity
- **No remove/control buttons** (not needed since agent auto-exits)

### 3.3 Agent Data Channel Communication

**File:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/agent/main.py` (lines 488–514)

```python
@ctx.room.on("data_received")
def on_data_received(data: rtc.DataPacket):
    try:
        msg = json.loads(data.data.decode())

        # Style change from any participant
        if (msg.get("type") == "set_style" and
            msg.get("style") in ("gentle", "moderate", "chatting")):
            meeting_state.style = msg["style"]
            asyncio.create_task(_refresh_agent_instructions(agent, meeting_state))

        # @beat mention in chat
        elif msg.get("type") == "chat_message" and not msg.get("is_agent"):
            text = msg.get("text", "")
            if text.strip().lower().startswith("@beat"):
                question = text.strip()[5:].strip()
                asyncio.create_task(
                    _handle_chat_mention(ctx.room, meeting_state, mistral_chat_client, agent, sender, question)
                )
    except Exception:
        logger.exception("Failed to handle data_received")
```

**Data Channel Topics:**
- `"agenda"` — sends agenda state updates (every 15s in monitoring loop)
- `"chat"` — @beat mentions and responses
- **Extensible:** can add new message types for agent control

---

## Part 4: Existing Participant Control Patterns (None Found)

### 4.1 Search Results

**Query:** "remove", "kick", "eject", "invite" across codebase

**Frontend:** Only `removeItem()` for agenda editor (removes agenda items, not participants)
**Server:** No participant removal endpoints
**Agent:** No participant ejection capabilities

**Conclusion:** Beat Your Meet has **zero** participant lifecycle management (invite/remove) because agents auto-join via dispatch and auto-exit when meeting ends.

---

## Part 5: Agent Lifecycle Management

### 5.1 Current Lifecycle

```
PASSIVE AUTO-JOIN:
  LiveKit Dispatch → ctx.connect() → wait_for_participant() → session.start() → monitoring_loop()

PASSIVE AUTO-EXIT:
  No more items in agenda → monitoring_loop breaks → session ends → participant leaves room
```

**Monitoring Loop Exit Condition:**

**File:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/agent/main.py` (lines 769–780)

```python
# Check if meeting is over (no more items)
if state.current_item is None:
    try:
        await _guarded_say(
            session,
            state,
            "That wraps up our agenda. Great meeting, everyone!",
            Trigger.WRAP_UP,
        )
    except Exception:
        logger.exception("Failed to deliver meeting wrap-up")
    break  # ← EXIT: terminates monitoring_loop and session
```

### 5.2 No Pause/Resume Mechanism

- Agent cannot be paused mid-meeting
- Agent cannot be kicked out by users
- Agent cannot be re-invited after leaving
- Only way to "remove" agent is to kill LiveKit room

### 5.3 Monitoring Loop Responsibilities

**File:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/agent/main.py` (lines 744–850+)

The monitoring loop runs every 15 seconds and handles:
1. **Time-based state transitions** (UPCOMING → ACTIVE → WARNING → OVERTIME → COMPLETED)
2. **Tangent detection** (via Mistral Small with tool calling)
3. **Automatic agenda item advancement** (when time expires)
4. **Item summarization** (generating meeting notes)
5. **Data channel communication** (sending agenda state to frontend)
6. **Intervention scheduling** (respecting 30-second cooldown)

---

## Part 6: Architecture Summary and CLAUDE.md Guidance

### 6.1 Three Independent Services (Per CLAUDE.md)

```
Frontend (Next.js 14)
  ↓
Server (FastAPI)
  ├→ /api/token (LiveKit token generation)
  ├→ /api/agenda (Mistral-powered agenda generation)
  └→ /api/room (Room creation with metadata)
  ↓
Agent (LiveKit Agents Framework)
  ├→ Worker dispatch (automatic or manual)
  └→ Monitoring loop + voice pipeline
  ↓
LiveKit (Room + Real-time Communication)
  ├→ Audio/video tracks
  ├→ Data channels (agenda, chat topics)
  └→ Participant management
```

### 6.2 Data Flow for Agent

**Current:**
```
Room Creation → Metadata Storage → LiveKit Dispatch → Agent Joins → Monitoring Loop
```

**New (for invitable agent):**
```
Room Creation → Invite Agent Call → Dispatch + Agent Joins → Monitoring Loop → Room Signal or API Call → Agent Exits
```

### 6.3 Design Decisions from CLAUDE.md Relevant to Participation

1. **Mistral Large** for main LLM, **Mistral Small** for fast 15s monitoring checks
2. **Tool calling** for structured tangent detection (>0.7 confidence threshold)
3. **Intervention cooldown** of 30 seconds prevents excessive interruptions
4. **MeetingState** is a state machine (ItemState: UPCOMING → ACTIVE → WARNING → OVERTIME → EXTENDED → COMPLETED)
5. **Transcript buffer** keeps only last 2 minutes of conversation
6. **Three facilitation styles** control intervention tone/tolerance

**Missing:** Explicit participant lifecycle (invite/remove) — only implicit auto-join/auto-exit

---

## Part 7: What Would Need to Change for Real Participant Status

### 7.1 Server Changes (FastAPI)

**New Endpoint: `/api/agent/invite`**
```python
@app.post("/api/agent/invite")
async def invite_agent(req: InviteAgentRequest):
    """Explicitly dispatch agent to an existing room."""
    try:
        # 1. Verify room exists
        lk_api = api.LiveKitAPI(...)
        rooms = await lk_api.room.list_rooms(api.ListRoomsRequest(names=[req.room_name]))
        if not rooms.rooms:
            raise HTTPException(status_code=404, detail="Room not found")

        # 2. Create dispatch request to agent worker
        dispatch_service = api.AgentDispatchService(lk_api)
        await dispatch_service.create(api.CreateAgentDispatchRequest(
            room=req.room_name,
            agent=os.environ.get("AGENT_NAME", "beat-your-meet"),
        ))

        return {"status": "invited", "room_name": req.room_name}
    finally:
        await lk_api.aclose()

@app.post("/api/agent/remove")
async def remove_agent(req: RemoveAgentRequest):
    """Signal agent to leave or kick it from a room."""
    try:
        # 1. Send data channel message to agent
        lk_api = api.LiveKitAPI(...)
        rooms = await lk_api.room.list_rooms(api.ListRoomsRequest(names=[req.room_name]))
        if not rooms.rooms:
            raise HTTPException(status_code=404, detail="Room not found")

        # 2. Option A: Send graceful exit signal via data channel
        # Option B: Remove participant via LiveKit API
        # await lk_api.room.remove_participant(...)

        return {"status": "removed", "room_name": req.room_name}
    finally:
        await lk_api.aclose()
```

### 7.2 Agent Changes

**Data Channel Message Type for Graceful Exit:**
```python
# Add to on_data_received handler
elif msg.get("type") == "agent_exit":
    logger.info("Graceful exit requested")
    break  # Exit monitoring loop and session
```

**Agent Identity Control (Currently Implicit):**
```python
# Agent is identified by LiveKit's ParticipantKind.AGENT
# To have explicit name, configure in LiveKit workspace or:
agent_identity = os.environ.get("AGENT_IDENTITY", "beat-facilitator")
# Use this when initializing participant
```

### 7.3 Frontend Changes

**New UI Components:**
```typescript
// Components/AgentControls.tsx
<button onClick={() => inviteAgent()}>Invite Agent</button>
<button onClick={() => removeAgent()}>Remove Agent</button>

// Add to SmartParticipantTile for agent-specific buttons
{isBotParticipant && isHost && (
  <div className="agent-controls">
    <button onClick={removeAgent} title="Remove agent from meeting">
      ×
    </button>
  </div>
)}
```

### 7.4 Room Creation Changes (Optional)

**Option A: Auto-dispatch (current approach)**
```python
# No changes — use room metadata with agent marker
room_metadata = {
    "agenda": req.agenda,
    "style": req.style,
    "access_code": access_code,
    "auto_invite_agent": True,  # ← NEW FLAG
}
```

**Option B: Manual dispatch (new approach)**
```python
# Remove auto-dispatch, explicit invite via API after room creation
room_metadata = {
    "agenda": req.agenda,
    "style": req.style,
    "access_code": access_code,
}
# Then: await invite_agent(room_name)
```

---

## Part 8: Current Agent Identity Detection

### 8.1 Identity Patterns

**How the frontend identifies the agent:**
1. Check `participant.kind === ParticipantKind.AGENT` (most reliable)
2. Check `participant.identity.startsWith("agent-")`
3. Check `participant.identity.toLowerCase().includes("bot")`

**What the agent's actual identity is:**
- **Not explicitly set in code** — LiveKit assigns automatically when ParticipantKind.AGENT
- Likely: `"agent"` or `"Beat"` or a LiveKit-generated ID

**To set explicit agent identity:**
```python
# In entrypoint or agent initialization
agent_identity = os.environ.get("AGENT_IDENTITY", "beat-facilitator")
# Would need to be passed to session.start() or LiveKit config
```

---

## Part 9: Function Tools Added Recently

**Commit:** `12505fe` — "Enhance BeatFacilitatorAgent with new function tools for live meeting data retrieval"

**File:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/agent/main.py` (lines 305–343)

```python
@function_tool()
async def get_participant_count(self, context: RunContext) -> dict:
    """Get the current number of participants in the meeting room."""
    if not self._room:
        return {"participant_count": 0, "participants": []}
    participants = list(self._room.remote_participants.values())
    return {
        "participant_count": len(participants),
        "participants": [p.identity for p in participants],
    }

@function_tool()
async def get_meeting_info(self, context: RunContext) -> dict:
    """Get current meeting status including timing and progress."""
    state = self._meeting_state
    item = state.current_item
    return {
        "agenda_title": state.agenda_title,
        "style": state.style,
        "current_item": item.topic if item else None,
        # ... more fields
    }

@function_tool()
async def get_agenda(self, context: RunContext) -> dict:
    """Get the full meeting agenda with all items and their current status."""
    # Implementation...
```

**These tools enable:**
- Agent to query participant list (but not manipulate it)
- Agent to get meeting info (for context-aware responses)
- Agent to retrieve full agenda (for LLM context)

**None of these are for participant control** — they're read-only data retrieval.

---

## Part 10: Key Insights & Recommendations

### 10.1 Current State (As Designed)

✅ **Agent joins automatically via dispatch**
✅ **Agent detects when meeting ends and exits gracefully**
✅ **Agent can receive control signals via data channels**
✅ **Agent is visually distinct from humans in UI**

❌ **Agent cannot be user-invited to existing rooms**
❌ **Agent cannot be user-removed from a room**
❌ **No participant lifecycle management API**
❌ **No UI controls for agent presence**

### 10.2 Making Agent a "Real Participant"

**Low Effort (Recommended First Step):**
1. Add explicit `/api/agent/invite` endpoint to server
2. Call LiveKit's agent dispatch API explicitly
3. Frontend: Add "Invite Agent" button on room setup
4. Document: agent identity, how to identify in participant list

**Medium Effort (Mid-Step):**
1. Add `/api/agent/remove` endpoint
2. Send graceful exit signal via data channel
3. Frontend: Add "Remove Agent" button in participant tile
4. Handle agent absence (disable agent controls if not present)

**High Effort (Full Implementation):**
1. Make agent optional (not auto-invited to every room)
2. Add explicit agent lifecycle state (invited, active, removed)
3. Track agent state in room metadata
4. Frontend: Full agent management UI (invite, pause, resume, kick)
5. Agent: Pause/resume monitoring loop (don't exit completely)

### 10.3 Architectural Alignment

All changes align with CLAUDE.md's three-service architecture:
- **Frontend:** Add UI components for agent control
- **Server:** Add agent dispatch/removal endpoints
- **Agent:** Add data channel handlers for control signals + lifecycle pause/resume

**No changes to core algorithm** (Mistral LLM, monitoring loop, tangent detection, time state machine).

---

## Part 11: File Locations Summary

### Agent Service
- **Main entrypoint:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/agent/main.py`
- **Monitoring loop:** Lines 744–850+
- **BeatFacilitatorAgent class:** Lines 229–343
- **Data channel handler:** Lines 488–514
- **Exit condition:** Lines 769–780

### Server Service
- **Main:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/server/main.py`
- **Room creation:** Lines 181–220
- **Token generation:** Lines 56–100
- **Metadata structure:** Lines 189–195

### Frontend Service
- **Room page:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/frontend/app/room/[id]/page.tsx`
- **Agent detection:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/frontend/components/SmartParticipantTile.tsx` (lines 31–36, 60–112)
- **Participant tiles:** Same file
- **Chat panel:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/frontend/components/ChatPanel.tsx`

### Configuration & Docs
- **Project instructions:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/CLAUDE.md`
- **Testing guide:** `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/TESTING.md`
- **Architecture:** CLAUDE.md lines 10–32

---

## Conclusion

Beat Your Meet's agent currently operates as a **passive, auto-joining, auto-exiting system** via LiveKit's worker dispatch mechanism. To transform it into a **real, controllable participant**, the system needs:

1. **Explicit invite mechanism** (server API + frontend UI)
2. **Graceful removal mechanism** (data channel signals + optional lifecycle pause/resume)
3. **Agent identity management** (explicit naming, metadata tracking)
4. **Frontend participant controls** (buttons for invite/remove, UI state management)

All changes fit naturally within the existing three-service architecture and preserve the core algorithm and design decisions documented in CLAUDE.md.
