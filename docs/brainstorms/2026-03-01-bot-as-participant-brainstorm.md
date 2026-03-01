# Brainstorm: Bot as a Real Participant

**Date:** 2026-03-01
**Status:** Ready for planning

## What We're Building

Transform the AI facilitator from an auto-joining system service into a controllable participant that can be explicitly invited and removed from meetings — while giving it a distinct but natural presence in the participant list.

### User Stories

- As a **host**, I want to toggle whether the facilitator joins when I create a meeting, so I can choose upfront.
- As a **host**, I want to invite the facilitator mid-meeting if I didn't include it at setup, so I have flexibility.
- As a **host**, I want to remove the facilitator mid-meeting, and it should truly leave the room.
- As a **host**, I want to re-invite the facilitator after removing it, in case I change my mind.
- As a **participant**, I want the bot to appear naturally in the participant list with subtle branding (distinct avatar, clear label), so it feels like part of the meeting without pretending to be human.

## Why This Approach

**Server-Controlled Dispatch** — New server endpoints (`/api/agent/invite`, `/api/agent/remove`) manage the agent lifecycle. The frontend calls these endpoints; the agent no longer auto-joins.

Why this over alternatives:
- **Fits existing architecture:** The server already mediates between frontend and LiveKit (token gen, room creation). Adding agent lifecycle control here is natural.
- **Agent truly leaves on remove:** No phantom resource consumption. Clean join/leave semantics.
- **Single source of truth:** Server knows whether the agent is in the room, avoiding state sync issues.
- **Debuggable:** Explicit HTTP calls are easier to trace than metadata watching or data channel signals.

## Key Decisions

1. **Invite flow:** Toggle on meeting setup page + in-meeting invite button. Both paths call the same server endpoint.
2. **Remove behavior:** Agent leaves the room completely. Can be re-invited via the in-meeting button.
3. **No auto-join:** Agent only joins when explicitly invited (toggle on = auto-invite at room creation).
4. **Identity:** Subtle branding — distinct bot avatar and clear "Facilitator" label, but natural presence in the participant list. No fake human persona.
5. **Approach:** Server-controlled dispatch via new API endpoints. No data channel control or metadata polling.

## Scope

### In Scope
- "Invite Facilitator" toggle on meeting setup page
- Server endpoints: `POST /api/agent/invite`, `POST /api/agent/remove`
- In-meeting invite/remove button (host only)
- Agent presence state tracking in frontend (absent / joining / active / leaving)
- Subtle bot identity (avatar + label) in participant list

### Out of Scope
- Pause/resume (agent stays but goes silent) — could be a future enhancement
- Multiple bot instances per room
- Non-host participants controlling the bot
- Custom bot names or avatars per meeting

## Open Questions

- Should the agent announce itself when joining/leaving? (e.g., "I'm here to help keep you on track" / "Signing off!")
- Should there be a visual indicator of agent status beyond the participant list? (e.g., a banner or sidebar widget)
- How should the frontend handle the delay between invite and agent actually joining? (loading state?)
