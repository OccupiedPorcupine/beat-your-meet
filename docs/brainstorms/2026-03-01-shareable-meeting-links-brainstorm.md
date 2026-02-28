---
date: 2026-03-01
topic: shareable-meeting-links
---

# Shareable Meeting Links with Access Code

## What We're Building

Add a simple access code mechanism so meeting creators can share a link that participants use to join. The code can be embedded in the URL for one-click joining, or entered manually on a PIN screen if the link is accessed without the code.

No user accounts, no database, no new infrastructure. The code is stored in LiveKit room metadata alongside the existing agenda and style fields.

## Why This Approach

We considered storing codes server-side (in-memory dict) vs. in LiveKit room metadata. Room metadata wins because it requires zero new infrastructure, the code naturally expires when the room does, and it's consistent with how we already store agenda/style.

We chose "code in URL + PIN fallback" over URL-only or PIN-only because it gives the best of both worlds: easy sharing via a single link, but still allows manual code entry if someone only has the room name.

## Key Decisions

- **Code format**: Short alphanumeric code (e.g. `MEET-7X3K`) — easy to read aloud or type
- **Storage**: LiveKit room metadata (`metadata.code`)
- **Validation point**: Server-side in `/api/token` — no token issued without correct code
- **URL format**: `/room/{room_name}?code={code}` for one-click join
- **PIN fallback**: If `?code=` is missing from URL, show a PIN entry screen before the pre-join name screen
- **Agent unchanged**: Agent ignores the code field in metadata

## Changes by Layer

| Layer | File | Change |
|-------|------|--------|
| Server | `server/main.py` | `/api/room` generates code, stores in metadata. `/api/token` validates code param against room metadata. |
| Frontend | `frontend/app/page.tsx` | After room creation, show shareable link + code with copy button. |
| Frontend | `frontend/app/room/[id]/page.tsx` | Read `?code=` from URL. If missing, show PIN entry UI. Pass code to `/api/token`. |
| Agent | (none) | No changes needed. |

## Out of Scope (intentionally)

- User accounts / authentication
- Room expiry / cleanup logic
- Rate limiting on code attempts
- Room listing / dashboard
- Persistent storage / database

## Open Questions

- None — design is straightforward enough to proceed.

## Next Steps

-> `/workflows:plan` for implementation details
