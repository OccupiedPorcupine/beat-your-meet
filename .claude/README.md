# Agent Participation Research Documentation

## Overview

This directory contains comprehensive research on making the Beat Your Meet agent a "real participant" that can be explicitly invited to or removed from LiveKit rooms, rather than being automatically joined via worker dispatch.

## Documents

### 1. **agent_participation_patterns.md** (Primary Document)
Comprehensive analysis of current architecture and how to transform the agent into a controllable participant.

**Key sections:**
- How the agent currently joins rooms (worker dispatch via LiveKit Agents Framework)
- How rooms are created and managed (FastAPI server)
- Frontend interaction with agent presence (React/LiveKit components)
- Existing participant control patterns (none — architecture currently lacks this)
- Agent lifecycle management (implicit auto-join/auto-exit)
- Architectural alignment with CLAUDE.md
- What would need to change for real participant status

**Best for:** Understanding the complete picture and design decisions

### 2. **agent_lifecycle_diagrams.md** (Visual Reference)
ASCII diagrams and flow charts showing:
- Current auto-join/auto-exit flow
- Proposed explicit invite/remove flow
- Data channel message patterns
- Agent identity detection in frontend
- Server endpoint changes
- Implementation complexity spectrum
- Frontend state machine for agent presence

**Best for:** Quick visual understanding, comparing current vs. proposed architecture

### 3. **agent_participation_code_examples.md** (Implementation Guide)
Ready-to-use code examples organized by implementation phase:
- Phase 1: Explicit agent invite (low effort, ~4 hours)
- Phase 2: Agent removal (medium effort, ~12 hours total)
- Phase 3: Advanced features (pause/resume, optional)
- Testing and integration checklist

**Best for:** Starting implementation, copy-paste templates

## Key Findings

### Current State

**Architecture:**
- Agent uses LiveKit Workers Framework with automatic job dispatch
- Agent joins room via `entrypoint(ctx: JobContext)` → `ctx.connect()`
- Agent exits when monitoring loop detects all agenda items are complete
- **No user-controlled participation** (invite/remove mechanisms)

**Files:**
- Agent join logic: `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/agent/main.py` (lines 388–561)
- Monitoring loop: `agent/main.py` (lines 744–850+)
- Room creation: `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/server/main.py` (lines 181–220)
- Agent detection in UI: `/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/frontend/components/SmartParticipantTile.tsx` (lines 31–36)

### Transformation Path

To make the agent a "real participant":

1. **Add explicit invite endpoint** (`/api/agent/invite`) to server
   - Calls LiveKit dispatch API explicitly instead of relying on implicit dispatch
   - ~20 lines of code, 1–2 hours

2. **Add remove endpoint** (`/api/agent/remove`) to server
   - Uses LiveKit API to remove participant OR sends graceful exit signal
   - ~30 lines of code, 2–4 hours

3. **Update frontend UI**
   - Add "Invite Agent" button on room setup
   - Add "Remove Agent" button on agent participant tile
   - Implement state machine to track agent presence (absent → invited → active → removed)
   - ~100 lines of code, 2–6 hours

4. **Optional: Pause/Resume** (Phase 3)
   - Add monitoring loop pause capability
   - Add data channel handlers for pause/resume signals
   - ~70 lines total, 4–6 hours

### Alignment with Project Architecture

All proposed changes align with CLAUDE.md's three-service architecture:

```
Frontend (Next.js)
  ├→ New: "Invite Agent" button on setup page
  └→ New: "Remove Agent" button on participant tile

Server (FastAPI)
  ├→ New: /api/agent/invite endpoint
  ├→ New: /api/agent/remove endpoint
  └→ Existing: /api/room (no changes needed)

Agent (LiveKit Agents)
  ├→ Existing: entrypoint() for explicit dispatch
  └→ Optional: Handle control signals (Phase 3)
```

**Zero changes to core algorithm:**
- Mistral LLM integration
- Monitoring loop tangent detection
- Time-based state machine
- Intervention cooldown
- Transcript buffer

## Recommendation

### Phase 1 + 2 (Standard Implementation)
**Effort:** 4–12 hours total (1–2 days)
**Impact:** Users can invite agent explicitly and remove it mid-meeting

**Deliverables:**
- 2 new server endpoints (~60 lines)
- 1 new frontend component + state updates (~100 lines)
- Updated documentation

**Result:** Agent becomes a controllable participant without changing core functionality

### Why Not Phase 3?
Phase 3 (pause/resume) is valuable but requires more complex state management. It's better to implement Phase 1+2 first, get user feedback, then add Phase 3 if needed.

## How to Use This Documentation

1. **Start here:** Read the overview section in `agent_participation_patterns.md`

2. **Understand the architecture:** Read sections 1–6 of `agent_participation_patterns.md`

3. **Visualize the changes:** Look at diagrams 1–3 in `agent_lifecycle_diagrams.md`

4. **Plan implementation:** Review the complexity spectrum in `agent_lifecycle_diagrams.md` diagram 6

5. **Start coding:** Copy templates from `agent_participation_code_examples.md` Phase 1 and 2

6. **Test:** Follow the checklist and manual test scripts in `agent_participation_code_examples.md`

## Quick Reference: File Locations

### Agent Service
```
/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/agent/
├── main.py
│   ├── entrypoint() @ line 388 — Agent join logic
│   ├── _monitoring_loop() @ line 744 — Meeting facilitation loop
│   ├── on_data_received() @ line 488 — Data channel handler (extensible)
│   └── BeatFacilitatorAgent @ line 229 — Agent class with function tools
├── monitor.py — Meeting state machine (MeetingState, ItemState)
├── prompts.py — System prompts for Mistral
└── requirements.txt
```

### Server Service
```
/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/server/
├── main.py
│   ├── @app.post("/api/token") @ line 56 — Token generation
│   ├── @app.post("/api/agenda") @ line 136 — Agenda generation
│   ├── @app.post("/api/room") @ line 181 — Room creation
│   └── (Add /api/agent/invite and /api/agent/remove here)
└── requirements.txt
```

### Frontend Service
```
/Users/leongshiwei/SWs_Stuff/04_Career/Hackiedonz/beat-your-meet/frontend/
├── app/
│   ├── page.tsx — Home page (add invite toggle here)
│   └── room/[id]/page.tsx — Meeting room page
├── components/
│   ├── SmartParticipantTile.tsx @ line 31 — Agent detection & display
│   ├── ChatPanel.tsx — Chat interface
│   └── AgendaDisplay.tsx — Agenda visualization
└── package.json
```

## Key Code Patterns to Understand

### 1. Agent Detection in Frontend
```typescript
function isBot(participant: { kind?: unknown; identity: string }): boolean {
  if (participant.kind === ParticipantKind.AGENT) return true;
  return (
    participant.identity.startsWith("agent-") ||
    participant.identity.toLowerCase().includes("bot")
  );
}
```

### 2. Agent Join Logic
```python
async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    participant = await ctx.wait_for_participant()
    meeting_state = MeetingState.from_metadata(ctx.room.metadata)
    agent = BeatFacilitatorAgent(...)
    session = AgentSession()
    await session.start(agent, room=ctx.room)
    # Monitoring loop runs indefinitely until meeting ends
```

### 3. Data Channel Communication
```python
@ctx.room.on("data_received")
def on_data_received(data: rtc.DataPacket):
    msg = json.loads(data.data.decode())
    # Handle "set_style", "chat_message", etc.
    # NEW: Add "agent_exit", "agent_pause", "agent_resume" here
```

## Environment Variables Needed

```bash
# Existing (required)
LIVEKIT_URL=wss://...
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
MISTRAL_API_KEY=...
DEEPGRAM_API_KEY=...
ELEVEN_API_KEY=...

# New (for Phase 1+2)
AGENT_WORKER_NAME=beat-facilitator

# Optional (for explicit agent naming)
AGENT_IDENTITY=beat-facilitator
```

## Testing Strategy

### Unit Tests
- Server endpoints: `/api/agent/invite`, `/api/agent/remove`
- Frontend state machine: transitions between agent states
- Agent data channel handlers: message parsing and action

### Integration Tests
- Full flow: Create room → Invite agent → Agent joins → Remove agent → Agent leaves
- Concurrent operations: Multiple invite/remove calls
- Error handling: Invalid room names, network failures

### Manual Testing
See test checklist in `agent_participation_code_examples.md`

## Future Enhancements (Beyond Phase 3)

1. **Agent Pool Management**
   - Track multiple agent instances
   - Load balancing across rooms
   - Agent health checks

2. **Agent Customization**
   - Runtime style changes (already supported)
   - Dynamic facilitation mode updates
   - Custom system prompts per meeting

3. **Agent Analytics**
   - Track when agents are invited/removed
   - Measure agent effectiveness
   - Collect feedback on facilitation

4. **Advanced Lifecycle**
   - Agent handoff between instances
   - Graceful shutdown with agenda summary
   - Automatic re-invite on failure

## Questions & Troubleshooting

### Q: Why not auto-dispatch to every room?
**A:** Current design does this, but it prevents users from controlling agent presence. Explicit invite gives users agency and reduces costs (don't pay for agent resources unless needed).

### Q: Why use API removal instead of graceful exit?
**A:** API removal is simpler for Phase 2 (no agent code changes). Graceful exit can be added in Phase 3 with data channel messages if needed.

### Q: How does agent identity get determined?
**A:** LiveKit assigns identity automatically when ParticipantKind.AGENT is set. Can be made explicit via environment variable.

### Q: Can the agent be paused without exiting?
**A:** Not in current design. Phase 3 adds this capability. For now, remove and re-invite.

### Q: What happens if agent is removed mid-intervention?
**A:** Agent is forcefully disconnected. Monitoring loop stops, session ends. Current user experience: agent suddenly stops talking.

For graceful handling, implement Phase 3 with pause capability.

## Document Maintenance

These research documents were created on **2026-03-01** based on codebase analysis and CLAUDE.md guidance.

**To keep up-to-date:**
1. Update if agent service changes significantly
2. Update if LiveKit API changes
3. Update when implementation is completed (move completed items to IMPLEMENTED.md)
4. Update for new features added in Phase 3+

**Last verified:** 2026-03-01 at commit 12505fe ("Enhance BeatFacilitatorAgent with new function tools")

---

## Related Documentation

- **CLAUDE.md:** Project overview and architectural decisions
- **TESTING.md:** Manual testing guide for existing features
- **README.md:** Project setup and getting started
- **bugs.md:** Known issues and limitations
- **change_strictness.md:** Configuration for facilitation strictness

---

## Contact & Attribution

Research conducted as detailed repository analysis for Claude Code.

For questions about implementation, refer to:
- LiveKit Agents Framework: https://docs.livekit.io/agents/
- FastAPI: https://fastapi.tiangolo.com/
- React/LiveKit Components: https://docs.livekit.io/references/components-js/
