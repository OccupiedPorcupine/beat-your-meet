# Agent Lifecycle Architecture Diagrams

## Diagram 1: Current Auto-Join/Auto-Exit Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│ CURRENT SYSTEM: Passive Auto-Join via Worker Dispatch                   │
└─────────────────────────────────────────────────────────────────────────┘

FRONTEND                          SERVER                    AGENT WORKER
    │                              │                            │
    ├─ Generate Agenda ────────→ Mistral LLM                    │
    │                              │                            │
    ├─ Create Room ────────────→ /api/room                      │
    │                              │                            │
    │                     Room created in LiveKit               │
    │                              │                            │
    │                              │    [LiveKit Dispatch]      │
    │                              ├──────────────────────→ Worker pool
    │                              │                            │
    │                              │              Dispatch job received
    │                              │                            │
    │                              │              entrypoint(ctx: JobContext)
    │                              │                            │
    │                              │              ctx.connect()─┤
    │                              │              Auto-join      │
    │                              │                    ┌───────┘
    │                              │         Wait for   │
    │                  ┌─────────→ (humans join first)
    │                  │
    User token /api/token
    │                  │
    ├─ Join Room ─────┤
    │ (first human)   │
    │                  │
    │                  └─ Session starts + monitoring loop begins
    │
    │
    ├─ See agent in participants list (identified as ParticipantKind.AGENT)
    │
    │  [15s monitoring loop runs continuously]
    │
    │  - Time-based transitions
    │  - Tangent detection
    │  - Data channel updates to frontend
    │
    │  (meeting progresses...)
    │
    ├─ Agenda item advances, time expires, reaches last item
    │
    │                              ┌─ Monitoring loop: if current_item is None:
    │                              │    - Say "That wraps up our agenda"
    │                              │    - break (exit loop)
    │                              │
    │                          Session ends
    │                          ctx.disconnect()
    │
    └─ Agent disappears from participants list


    ⏱️ TOTAL DURATION: Entire meeting duration (auto-join at start, auto-exit at end)


┌─────────────────────────────────────────────────────────────────────────┐
│ KEY CONSTRAINT: Agent joins via system dispatch, NOT user action        │
│ Result: No way for users to invite/remove mid-meeting                   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Diagram 2: Proposed Explicit Invite/Remove Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│ PROPOSED SYSTEM: Explicit Invite/Remove with Lifecycle Control          │
└─────────────────────────────────────────────────────────────────────────┘

FRONTEND                          SERVER                    AGENT WORKER
    │                              │                            │
    ├─ Generate Agenda ────────→ Mistral LLM                    │
    │                              │                            │
    │                    ┌────────────────────┐                 │
    │                    │ OPTION A: Auto     │                 │
    │                    │ add room metadata  │                 │
    │                    │ flag for dispatch  │                 │
    │                    └────────────────────┘                 │
    │                              │                            │
    │ OR                           │                            │
    │                    ┌────────────────────┐                 │
    │                    │ OPTION B: Explicit │                 │
    │                    │ /api/agent/invite  │                 │
    │                    │ after room created │                 │
    │                    └────────────────────┘                 │
    │                              │                            │
    ├─ Create Room ────────────→ /api/room                      │
    │                              │                            │
    │                     Room created in LiveKit               │
    │                              │                            │
    │   (Room created WITHOUT agent yet)                        │
    │                              │                            │
    │                    ┌─────────────────────┐               │
    │        IF OPTION B: ├─ /api/agent/invite │               │
    │                    │ (explicit dispatch)  │               │
    │                    └──────────┬───────────┘               │
    │                              │                            │
    │                              │    [LiveKit Dispatch]      │
    │                              ├──────────────────────→ Worker pool
    │                              │                            │
    │                              │         Dispatch job received
    │                              │                            │
    │                              │              entrypoint(ctx)
    │                              │                            │
    │                              │              ctx.connect()─┤
    │                              │                            │
    │                              │         Wait for humans     │
    │                              │                            │
    │  Agent ready + listening                                  │
    │                              │                            │
    │  User joins / gets token                                  │
    │                              │                            │
    ├─ Join Room ─────────────────→ (normal join flow)
    │ (first human)                │
    │                              │
    │  ✓ Agent appears in participants list
    │
    │  [15s monitoring loop active]
    │
    │                  SCENARIO 1: Normal Meeting Completion
    │                  ───────────────────────────────────────
    │  (meeting continues, reaches end)
    │
    │  Agent: Monitoring loop detects current_item is None
    │         → Says "That wraps up our agenda"
    │         → Breaks loop, exits gracefully
    │
    │  ✗ Agent disappears from participants list (auto-exit)
    │
    │
    │                  SCENARIO 2: User Removes Agent (NEW)
    │                  ──────────────────────────────────────
    │  User clicks "Remove Agent" button in UI
    │                              │
    │  ├─ /api/agent/remove ──────→
    │  │                              │
    │  │                    Option A: Send data channel message
    │  │                              ├─ Data payload: {"type": "agent_exit"}
    │  │                              ├──────────────→ Agent.on_data_received()
    │  │                              │                   → break (graceful exit)
    │  │                              │
    │  │                    Option B: LiveKit API removal
    │  │                              ├─ api.room.remove_participant(agent_id)
    │  │                              │
    │  │                    Option C: Agent pause (NEW)
    │  │                              ├─ Data: {"type": "pause_monitoring"}
    │  │                              │   Agent stops monitoring, stays connected
    │  │                              │
    │  │
    │  ✗ Agent disappears from participants list (or pauses)
    │
    │
    │                  SCENARIO 3: User Re-invites Agent (NEW)
    │                  ────────────────────────────────────────
    │  User clicks "Invite Agent" button in UI
    │                              │
    │  ├─ /api/agent/invite ──────→ Dispatch another instance OR
    │  │                              Send unpause signal
    │  │                              │
    │  │                    (Agent respawns or resumes)
    │  │
    │  ✓ Agent reappears in participants list
    │  Agent rejoins monitoring loop from current state
    │
    │
    │  (meeting ends whenever scheduled)
    │
    └─ Agent exits or paused


┌─────────────────────────────────────────────────────────────────────────┐
│ KEY ADVANTAGE: User controls agent presence, not system dispatch alone  │
│ Implementation: Low = invite only, High = invite/remove/pause/resume    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Diagram 3: Data Channel Message Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│ DATA CHANNEL COMMUNICATION: Frontend ↔ Agent (Existing)                 │
└─────────────────────────────────────────────────────────────────────────┘

TOPIC: "agenda" (from agent to frontend — every 15s)
───────────────────────────────────────────────────
Payload: {
  "type": "agenda_state",
  "current_item_index": 0,
  "items": [
    {
      "id": 1,
      "topic": "Sprint Planning",
      "duration_minutes": 20,
      "state": "active",
      "actual_elapsed": 5.2
    },
    ...
  ],
  "elapsed_minutes": 5.2,
  "meeting_overtime": 0,
  "style": "moderate",
  "server_now_epoch": 1709297400,
  "meeting_start_epoch": 1709297395,
  "meeting_notes": [...]
}

Frontend listens via:
  const { message: agendaState } = useDataChannel("agenda");


TOPIC: "chat" (from frontend to agent & agent to frontend)
──────────────────────────────────────────────────────────
From frontend (user message):
{
  "type": "chat_message",
  "sender": "Alice",
  "text": "@beat what are we discussing?",
  "is_agent": false,
  "timestamp": 1709297400
}

From agent (response):
{
  "type": "chat_message",
  "sender": "Beat",
  "text": "We're currently on Sprint Planning for 20 minutes.",
  "is_agent": true,
  "timestamp": 1709297405
}

Agent listens via:
  @ctx.room.on("data_received")
  def on_data_received(data: rtc.DataPacket):
      msg = json.loads(data.data.decode())
      if msg.get("type") == "chat_message":
          # Process @beat mentions


TOPIC: "agent_control" (PROPOSED — new for invite/remove)
────────────────────────────────────────────────────────
From frontend (user action) to agent:
{
  "type": "agent_exit",      // Graceful exit
  "reason": "user_requested"
}

From frontend to agent:
{
  "type": "agent_pause",     // Pause monitoring without exiting
  "reason": "user_requested"
}

From frontend to agent:
{
  "type": "agent_resume",    // Resume monitoring from pause
  "reason": "user_requested"
}

Agent handles in on_data_received:
  elif msg.get("type") == "agent_exit":
      logger.info("Graceful exit requested")
      break  # Exit monitoring_loop → session ends


┌─────────────────────────────────────────────────────────────────────────┐
│ INTEGRATION POINTS:                                                      │
│ 1. Frontend chat panel already sends @beat mentions                      │
│ 2. Frontend agenda display already receives agenda_state                 │
│ 3. Agent data_received handler is extensible                            │
│ 4. Agent monitoring loop can handle pause/resume signals                 │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Diagram 4: Agent Identity Detection (Frontend)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ HOW FRONTEND IDENTIFIES AGENT IN PARTICIPANT LIST                       │
└─────────────────────────────────────────────────────────────────────────┘

LiveKit ParticipantList: [ Alice (human), Beat (agent), Bob (human) ]
                          │                   ↓
                          │        (SmartParticipantTile.tsx)
                          │
                    isBot(participant) function:
                          │
                    ┌─────┴──────┬─────────────────┐
                    │            │                 │
                    ▼            ▼                 ▼
            Check Kind      Check Identity    Check Identity
            ───────────     ──────────────    ──────────────

participant.kind ===
ParticipantKind.AGENT
│
└─→ YES (most reliable)
    │
    └─→ RENDER BOT TILE
        (blue robot avatar)


participant.identity
startsWith("agent-")
│
└─→ YES (fallback pattern)
    │
    └─→ RENDER BOT TILE


participant.identity
.toLowerCase()
.includes("bot")
│
└─→ YES (fallback pattern)
    │
    └─→ RENDER BOT TILE


If none match: RENDER HUMAN TILE
(with name, video, mute indicators)


CURRENT AGENT IDENTITY:
──────────────────────
Not explicitly set in code → LiveKit assigns automatically
Likely values: "agent" | "Beat" | UUID-based

TO MAKE EXPLICIT (NEW):
──────────────────────
agent_identity = os.environ.get("AGENT_IDENTITY", "beat-facilitator")
// Pass to LiveKit when joining or in session config


AGENT TILE DISPLAY:
──────────────────
┌──────────────────┐
│                  │
│    ◻︎ ◻︎         │  (blue robot SVG)
│    ●   ●         │
│    ▔▔▔▔▔▔         │  (smile)
│                  │
│   Beat Agent     │  (participant name)
│                  │
└──────────────────┘

POTENTIAL FUTURE (ParticipantKind.AGENT):
─────────────────────────────────────────
┌──────────────────┐
│   Remove Agent ✕ │  (host control)
├──────────────────┤
│                  │
│    ◻︎ ◻︎         │
│    ●   ●         │
│    ▔▔▔▔▔▔         │
│                  │
│   Beat Agent     │
│   (paused)       │  (status indicator)
│                  │
└──────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ FILE: /Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/  │
│       frontend/components/SmartParticipantTile.tsx                      │
│ Lines: 31–36 (isBot function), 60–112 (bot tile rendering)             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Diagram 5: Server Endpoint Changes Required

```
┌─────────────────────────────────────────────────────────────────────────┐
│ CURRENT SERVER ENDPOINTS (FastAPI)                                      │
└─────────────────────────────────────────────────────────────────────────┘

GET /api/health
├─ No auth required
└─ Returns: {"status": "ok"}


POST /api/token
├─ Generates LiveKit token for a participant
├─ Body: {
│   "room_name": "meet-abc123",
│   "participant_name": "Alice",
│   "access_code": "MEET-X4K2"
│ }
└─ Returns: {"token": "...jwt..."}


POST /api/agenda
├─ Generates agenda using Mistral LLM
├─ Body: {
│   "description": "Weekly standup",
│   "duration_minutes": 30
│ }
└─ Returns: {
    "title": "Weekly Standup",
    "items": [...],
    "total_minutes": 30
  }


POST /api/room
├─ Creates a new LiveKit room with metadata
├─ Body: {
│   "agenda": {...},
│   "style": "moderate"
│ }
└─ Returns: {
    "room_name": "meet-abc123",
    "access_code": "MEET-X4K2"
  }


┌─────────────────────────────────────────────────────────────────────────┐
│ PROPOSED ADDITIONAL ENDPOINTS (for agent invite/remove)                 │
└─────────────────────────────────────────────────────────────────────────┘

POST /api/agent/invite  ← NEW
├─ Explicitly dispatch agent to an existing room
├─ Body: {
│   "room_name": "meet-abc123"
│ }
├─ Auth: Optional (could require room access code or host token)
├─ Internal Logic:
│   1. Verify room exists via LiveKit API
│   2. Create dispatch job to agent worker
│   3. Agent worker receives job → entrypoint() called
│   4. Agent joins room
└─ Returns: {
    "status": "invited",
    "room_name": "meet-abc123"
  }


POST /api/agent/remove  ← NEW
├─ Signal agent to leave or kick it from room
├─ Body: {
│   "room_name": "meet-abc123",
│   "method": "graceful" | "force"  // optional
│ }
├─ Auth: Optional (could require host token)
├─ Internal Logic (Option A):
│   1. Send data channel message: {"type": "agent_exit"}
│   2. Agent on_data_received() → breaks monitoring loop
│   3. Session ends, agent leaves
├─ Internal Logic (Option B):
│   1. Use LiveKit API to remove participant by ID
│   2. Agent forcefully disconnected
└─ Returns: {
    "status": "removed",
    "room_name": "meet-abc123"
  }


POST /api/agent/pause  ← OPTIONAL (Advanced)
├─ Pause agent monitoring without exiting room
├─ Body: {
│   "room_name": "meet-abc123"
│ }
└─ Returns: {
    "status": "paused",
    "room_name": "meet-abc123"
  }


POST /api/agent/resume  ← OPTIONAL (Advanced)
├─ Resume agent monitoring from paused state
├─ Body: {
│   "room_name": "meet-abc123"
│ }
└─ Returns: {
    "status": "resumed",
    "room_name": "meet-abc123"
  }


┌─────────────────────────────────────────────────────────────────────────┐
│ FILE: /Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/ │
│       server/main.py                                                    │
│                                                                          │
│ Current endpoints: Lines 56–228                                         │
│ Recommended changes: Add after line 220 (after /api/room endpoint)      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Diagram 6: Implementation Complexity Spectrum

```
┌─────────────────────────────────────────────────────────────────────────┐
│ IMPLEMENTATION COMPLEXITY: LOW → HIGH                                   │
└─────────────────────────────────────────────────────────────────────────┘

PHASE 1: MINIMAL (Low Effort — 4–6 hours)
──────────────────────────────────────────
Goal: Enable user to explicitly invite agent to room (instead of auto-join)

Changes:
  Server:
    ✓ Add POST /api/agent/invite endpoint (20 lines)
    ✓ Call LiveKit dispatch API explicitly

  Frontend:
    ✓ Add "Invite Agent" button on room setup page (30 lines)
    ✓ Call /api/agent/invite after room creation (or before)

  Agent:
    ✗ No changes

UI Flow:
  [ Create Meeting ] → [ Setup Page ] → [ Invite Agent Button ] → [ Agent Joins ]

Result: Agent is still auto-included, but explicitly rather than implicitly

────────────────────────────────────────────────────────────────────────

PHASE 2: STANDARD (Medium Effort — 8–12 hours)
───────────────────────────────────────────────
Goal: Enable user to remove agent from room mid-meeting

Additions to Phase 1:
  Server:
    ✓ Add POST /api/agent/remove endpoint (30 lines)
    ✓ Send data channel message to agent

  Frontend:
    ✓ Add "Remove Agent" button in participant tile (40 lines)
    ✓ Call /api/agent/remove on click
    ✓ Hide button if agent not present

  Agent:
    ✓ Handle "agent_exit" in on_data_received (10 lines)
    ✓ Break monitoring loop and exit gracefully

UI Flow:
  [ Participant List ] → [ Agent Tile with Remove Button ] → [ Click Remove ] → [ Agent Exits ]

Result: Users can remove agent mid-meeting, agent exits gracefully

────────────────────────────────────────────────────────────────────────

PHASE 3: ADVANCED (High Effort — 16–24 hours)
──────────────────────────────────────────────
Goal: Full agent lifecycle control (invite, pause, resume, remove)

Additions to Phase 2:
  Server:
    ✓ Add POST /api/agent/pause endpoint (20 lines)
    ✓ Add POST /api/agent/resume endpoint (20 lines)
    ✓ Track agent state in room metadata

  Frontend:
    ✓ Add state machine: absent → invited → active → paused
    ✓ Show pause/resume buttons based on state (50 lines)
    ✓ Show visual indicator of agent status
    ✓ Add re-invite button if agent was removed

  Agent:
    ✓ Handle "agent_pause" signal (pause monitoring loop)
    ✓ Handle "agent_resume" signal (resume monitoring loop)
    ✓ Preserve state while paused (20 lines)

UI Flow:
  [ Agent Status Display ] → [ Pause / Resume / Remove Buttons ] → [ State Changes ]

Result: Full control over agent lifecycle, can pause without exiting

────────────────────────────────────────────────────────────────────────

BREAKDOWN BY COMPONENT:

┌─────────────────────────────────────────────────────────────────────────┐
│ SERVER (FastAPI main.py)                                                │
├─────────────────────────────────────────────────────────────────────────┤
│ Phase 1: +20 LOC (/api/agent/invite)                                    │
│ Phase 2: +30 LOC (/api/agent/remove)                                    │
│ Phase 3: +40 LOC (/api/agent/pause, /api/agent/resume)                  │
│ Total:   ~90 LOC (new endpoints only)                                   │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ AGENT (agent/main.py)                                                   │
├─────────────────────────────────────────────────────────────────────────┤
│ Phase 1: 0 changes                                                      │
│ Phase 2: +10 LOC (handle "agent_exit" in on_data_received)              │
│ Phase 3: +20 LOC (pause/resume state management)                        │
│ Total:   ~30 LOC (additions to data_received handler)                   │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ FRONTEND (React/TypeScript)                                             │
├─────────────────────────────────────────────────────────────────────────┤
│ Phase 1: +30 LOC (button on setup page)                                 │
│ Phase 2: +40 LOC (remove button in participant tile)                    │
│ Phase 3: +50 LOC (pause/resume buttons, state indicator)                │
│ Total:   ~120 LOC (new components + UI logic)                           │
└─────────────────────────────────────────────────────────────────────────┘

RECOMMENDED PATH: Phase 1 + Phase 2 (~150 LOC total, medium effort)
Enable invite and remove, covers 80% of use cases

────────────────────────────────────────────────────────────────────────

EFFORT COMPARISON:
  Phase 1:    ████░░░░░░  40% (1 day)
  Phase 1+2:  ████████░░  80% (2 days)
  Phase 1-3:  ██████████ 100% (3–4 days)

DEFAULT RECOMMENDATION: Phase 1 + Phase 2
────────────────────────────────────────────
✓ Low complexity
✓ High impact
✓ Covers most common use cases (invite agent, remove if not helping)
✓ Easy to extend to Phase 3 later
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Diagram 7: Agent State Machine (Proposed)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ AGENT PRESENCE STATE MACHINE (Frontend State Management)                │
└─────────────────────────────────────────────────────────────────────────┘

    ┌────────────┐
    │   ABSENT   │  (agent not invited to room)
    └─────┬──────┘
          │
          │ User clicks "Invite Agent"
          │ OR room auto-invites (Phase 1 with auto-flag)
          │
          ▼
    ┌────────────┐
    │  INVITED   │  (invite request sent, waiting for join)
    └─────┬──────┘
          │ ⏱️ ~2–5 seconds
          │
          │ Agent joins room (appears in participant list)
          │
          ▼
    ┌────────────┐
    │   ACTIVE   │  (agent monitoring + voice pipeline running)
    └─┬──────────┘
      │       ▲
      │       │
      │ User  │ User clicks "Resume"
      │ clicks│ (from paused state)
      │"Pause"│
      │       │
      ▼       │
    ┌────────────┐
    │  PAUSED    │  (agent in room but monitoring stopped)
    └─┬──────────┘
      │
      │ User clicks "Remove" OR meeting ends
      │
      ▼
    ┌────────────┐
    │  REMOVED   │  (agent exits room)
    └─────┬──────┘
          │
          │ User clicks "Invite Agent" again
          │
          ▼
    ┌────────────┐
    │  INVITED   │  (cycle repeats)
    └────────────┘


DIRECT TRANSITIONS:
───────────────────
ABSENT → INVITED (explicit user action or auto-config)
INVITED → ACTIVE (agent successfully joins)
ACTIVE → PAUSED (user request)
PAUSED → ACTIVE (user request)
ACTIVE/PAUSED → REMOVED (user request or meeting end)
REMOVED → INVITED (user requests agent again)


UI BUTTON VISIBILITY:
─────────────────────
ABSENT:  [Invite Agent]
INVITED: [Inviting...] (grayed out, loading state)
ACTIVE:  [Pause] [Remove]
PAUSED:  [Resume] [Remove]
REMOVED: [Invite Agent] (appears again)


FRONTEND CODE STRUCTURE:
────────────────────────
// Hooks to track agent state
const [agentState, setAgentState] = useState<AgentState>('absent');
const [agentParticipant, setAgentParticipant] = useState<Participant | null>(null);

// Listen for participant changes
useParticipants((participants) => {
  const agent = participants.find(p => isBot(p));
  setAgentParticipant(agent);

  if (agent && agentState === 'invited') {
    setAgentState('active');  // Transitioned: invited → active
  } else if (!agent && agentState !== 'absent') {
    setAgentState('removed');  // Transitioned: active/paused → removed
  }
});

// Handle user actions
async function inviteAgent() {
  setAgentState('invited');
  await fetch('/api/agent/invite', {...});
}

async function pauseAgent() {
  setAgentState('paused');
  await fetch('/api/agent/pause', {...});
}

async function removeAgent() {
  setAgentState('removed');
  await fetch('/api/agent/remove', {...});
}


CURRENT SYSTEM (for comparison):
─────────────────────────────────
No state machine — agent is in room the entire meeting
Equivalent to single state: [ACTIVE until meeting ends]

────────────────────────────────────────────────────────────────────────

RECOMMENDATION:
───────────────
Implement state machine in Phase 2 for cleaner UI logic
Start with ABSENT → ACTIVE → REMOVED (Phase 2)
Add PAUSED state in Phase 3
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Summary

These diagrams show:

1. **Current flow:** Passive auto-join/auto-exit via LiveKit dispatch
2. **Proposed flow:** Explicit invite/remove with optional pause/resume
3. **Data channel integration:** Extensible messaging already in place
4. **Agent identification:** Frontend already detects agents via ParticipantKind.AGENT
5. **Server changes:** Minimal new endpoints needed (2–4 endpoints)
6. **Implementation phases:** Can be done incrementally (Phase 1 < 4 hours, Phase 2 < 12 hours)
7. **State machine:** Proposed frontend state management for agent presence

All changes align with the existing three-service architecture and preserve the core algorithm.
