---
title: "feat: Controllable Bot Participant"
type: feat
date: 2026-03-01
brainstorm: docs/brainstorms/2026-03-01-bot-as-participant-brainstorm.md
---

# feat: Controllable Bot Participant

## Overview

Transform the AI facilitator from an auto-joining system service into a controllable participant. Hosts can invite or remove the bot via a setup toggle and in-meeting buttons. The bot uses LiveKit's explicit dispatch mode, appears in the participant list with subtle branding, and truly leaves the room when removed.

## Problem Statement / Motivation

Currently, the agent auto-joins every room unconditionally via LiveKit's implicit dispatch. There is no way to:
- Create a meeting without the bot
- Remove the bot mid-meeting
- Re-invite the bot after removal

This makes the bot feel like infrastructure, not a teammate. Hosts have no control over its presence.

## Proposed Solution

**Server-controlled explicit dispatch** with three coordinated changes:

1. **Agent** switches to `AgentDispatchType.EXPLICIT` — stops auto-joining
2. **Server** adds invite/remove endpoints that dispatch or kick the agent via LiveKit API
3. **Frontend** adds a setup toggle + in-meeting invite/remove button (host-only)

## Technical Approach

### Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Bot identity | Fixed string `"beat-facilitator"` | Predictable for frontend detection + server RemoveParticipant calls |
| Host auth | `host_token` returned from POST /api/room | Minimal auth without a full user system; required on bot-control endpoints |
| Remove mechanism | Server calls LiveKit `RemoveParticipant` | Direct, no new data channel message types needed |
| Invite idempotency | Check for existing bot participant before dispatch | Prevents double-bot scenarios |
| Re-invite state | Fresh state (no continuity) | Simpler; persisting MeetingState adds complexity for little gain |
| Joining timeout | 20 seconds on frontend | Resets to `absent` with error toast if bot never appears |
| Bot introduction on late join | Same intro, no special variant | Keep it simple for now; can refine later |

### Architecture

```
┌─────────────┐     POST /api/room        ┌──────────────┐
│   Frontend   │ ─── (invite_bot=true) ──→ │    Server     │
│              │                           │              │
│  Toggle ON   │     POST /invite-bot      │  LiveKit API  │
│  [Invite]    │ ────────────────────────→  │  .create_     │
│  [Remove]    │     DELETE /bot            │   dispatch()  │
│              │ ────────────────────────→  │  .remove_     │
│              │                           │   participant()│
└──────┬───────┘                           └──────┬────────┘
       │                                          │
       │  participant-joined/left events          │  explicit dispatch
       │  agenda data channel                     │
       │                                          ▼
       │                                   ┌──────────────┐
       └──────────────────────────────────→│    Agent      │
                                           │ (explicit     │
                                           │  dispatch     │
                                           │  mode)        │
                                           └──────────────┘
```

### Implementation Phases

#### Phase 1: Agent — Switch to Explicit Dispatch

**Files:** [agent/main.py](agent/main.py)

- [x] Add `agent_name="beat-facilitator"` to `WorkerOptions` (setting agent_name enables explicit dispatch)
- [x] Agent identity is set via `agent_name` in WorkerOptions
- [x] Add breadcrumb logging around dispatch acceptance

```python
# agent/main.py ~line 979
from livekit.agents import AgentDispatchType

cli.run_app(WorkerOptions(
    entrypoint_fnc=entrypoint,
    port=agent_port,
    agent_name="beat-facilitator",
    agent_dispatch_type=AgentDispatchType.EXPLICIT,
))
```

#### Phase 2: Server — Add Invite/Remove Endpoints + Host Auth

**Files:** [server/main.py](server/main.py)

- [x] Add `invite_bot: bool = True` field to `CreateRoomRequest`
- [x] Generate a `host_token` (random hex string) at room creation; store it in room metadata
- [x] Return `host_token` in the POST /api/room response alongside `room_name` and `access_code`
- [x] If `invite_bot=True`, call `lk_api.agent_dispatch.create_dispatch()` after room creation
- [x] Add `POST /api/room/{room_name}/invite-bot` endpoint with host_token verification and idempotency check
- [x] Add `DELETE /api/room/{room_name}/bot` endpoint with host_token verification and RemoveParticipant call

```python
# New Pydantic models
class CreateRoomRequest(BaseModel):
    agenda: dict
    style: str
    invite_bot: bool = True

class BotControlRequest(BaseModel):
    host_token: str

# POST /api/room/{room_name}/invite-bot
@app.post("/api/room/{room_name}/invite-bot")
async def invite_bot(room_name: str, req: BotControlRequest):
    # 1. Get room metadata, verify host_token
    # 2. Check if bot already present (list participants)
    # 3. Create explicit dispatch
    ...

# DELETE /api/room/{room_name}/bot
@app.delete("/api/room/{room_name}/bot")
async def remove_bot(room_name: str, req: BotControlRequest):
    # 1. Get room metadata, verify host_token
    # 2. Remove participant "beat-facilitator"
    ...
```

#### Phase 3: Frontend — Setup Toggle

**Files:** [frontend/app/page.tsx](frontend/app/page.tsx)

- [x] Add `inviteBot` state (default `true`) in the meeting creation component
- [x] Render a toggle switch between `StyleSelector` and the "Create Meeting" button
- [x] Pass `invite_bot: inviteBot` in the `POST /api/room` request body
- [x] Store `host_token` from the room creation response in sessionStorage
- [x] Pass `host_token` to the room page via sessionStorage (keyed by room name)

```typescript
// Simple toggle component inline — no separate file needed
<div className="flex items-center justify-between">
  <span>Invite Facilitator</span>
  <button onClick={() => setInviteBot(!inviteBot)}>
    {inviteBot ? "ON" : "OFF"}
  </button>
</div>
```

#### Phase 4: Frontend — In-Meeting Invite/Remove Button + Bot Presence State

**Files:** [frontend/app/room/[id]/page.tsx](frontend/app/room/[id]/page.tsx), [frontend/components/SmartParticipantTile.tsx](frontend/components/SmartParticipantTile.tsx)

- [x] Export `isBot()` from `SmartParticipantTile.tsx` with `"beat-facilitator"` identity check
- [x] Track bot presence state in `MeetingRoom` using `useParticipants()` + `isBot()`
- [x] Add invite/remove button in agenda panel with all 4 states (absent/joining/active/leaving)
- [x] Determine host status from sessionStorage `host_token`; only host sees controls
- [x] Wire button clicks to invite/remove endpoints with `host_token`
- [x] Style bot tile with "Beat" name + "Facilitator" badge

**Bot state machine in the frontend:**
```
absent ──[invite click]──→ joining ──[participant appears]──→ active
  ↑                           │ (20s timeout)                    │
  │                           ↓                                  │
  │                     absent + error toast              [remove click]
  │                                                              │
  └────────────[participant leaves]────── leaving ←──────────────┘
```

## Acceptance Criteria

- [ ] Creating a room with toggle ON → bot joins the room automatically
- [ ] Creating a room with toggle OFF → bot does NOT join; no auto-dispatch
- [ ] Clicking "Invite Facilitator" mid-meeting → bot joins within ~5 seconds
- [ ] Clicking "Remove Facilitator" → bot leaves the room completely
- [ ] After removing, clicking "Invite" again → bot re-joins fresh
- [ ] Double-clicking invite does not create two bots (idempotent)
- [ ] Only the host (holder of `host_token`) sees invite/remove controls
- [ ] Guests see the bot in the participant list but have no controls
- [ ] Bot tile displays "Facilitator" label with distinct avatar
- [ ] If bot fails to join within 20s, frontend shows error and resets to `absent`
- [ ] Non-host callers to invite/remove endpoints get 403

## Dependencies & Risks

| Risk | Mitigation |
|---|---|
| LiveKit agent framework silently swallows exceptions | Add breadcrumb logging at each init stage (per documented solution) |
| Agent worker offline when invite is called | 20s frontend timeout with error toast; server could optionally check worker availability |
| Breaking change for existing rooms | This is a hackathon project — no migration needed. Restart all services together |
| `host_token` is weak auth | Acceptable for a hackathon; a real product would use proper session auth |
| Re-invite loses meeting state | Documented as expected behavior. State persistence is out of scope |

## References & Research

### Internal References
- Agent entrypoint: [agent/main.py:389-569](agent/main.py#L389-L569)
- Worker options: [agent/main.py:979](agent/main.py#L979)
- Room creation: [server/main.py:181-220](server/main.py#L181-L220)
- Token generation: [server/main.py:56-100](server/main.py#L56-L100)
- Bot tile rendering: [frontend/components/SmartParticipantTile.tsx:60-113](frontend/components/SmartParticipantTile.tsx#L60-L113)
- Meeting setup UI: [frontend/app/page.tsx:331-355](frontend/app/page.tsx#L331-L355)
- In-meeting room UI: [frontend/app/room/[id]/page.tsx:334-358](frontend/app/room/[id]/page.tsx#L334-L358)
- Known agent crash pattern: [docs/solutions/runtime-errors/silent-agent-crash-elevenlabs-param-rename.md](docs/solutions/runtime-errors/silent-agent-crash-elevenlabs-param-rename.md)
- Brainstorm: [docs/brainstorms/2026-03-01-bot-as-participant-brainstorm.md](docs/brainstorms/2026-03-01-bot-as-participant-brainstorm.md)

### LiveKit Agent Dispatch
- `AgentDispatchType.EXPLICIT` requires `lk_api.agent_dispatch.create_dispatch()` to trigger agent join
- `lk_api.room.remove_participant(identity=...)` to force-remove the agent
- Agent identity set via `agent_name` in `WorkerOptions`
