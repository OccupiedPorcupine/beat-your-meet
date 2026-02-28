---
title: "feat: Add shareable meeting links with access code"
type: feat
date: 2026-03-01
---

# feat: Add shareable meeting links with access code

## Overview

Add a simple access code mechanism so meeting creators can share a link that lets participants join. The code can be embedded in the URL (`?code=MEET-7X3K`) for one-click joining, or entered manually on a PIN screen. Code is stored in LiveKit room metadata — no database, no user accounts.

## Problem Statement / Motivation

Currently, anyone who knows a room URL can join without restriction. There's no way for a creator to share a link with controlled access. This makes the platform feel incomplete compared to real meeting tools.

## Proposed Solution

1. Server generates a short access code at room creation, stores it in room metadata
2. Frontend shows the creator a shareable link with copy button before entering the room
3. Token endpoint validates the code before issuing a LiveKit token
4. Room page reads `?code=` from URL; if missing, shows a PIN entry screen first

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Code format | `MEET-` + 4 uppercase alphanumeric chars | Easy to read aloud, type, and share. ~1.7M combinations — sufficient for non-adversarial use |
| Code generation | `secrets.token_hex(3)` filtered to alphanumeric, uppercased | Cryptographically random, simple |
| Storage | LiveKit room metadata (`metadata.access_code`) | Zero infrastructure, expires with room |
| Validation | Server-side in `/api/token` | Single gate — no token = no join |
| Case sensitivity | Case-insensitive (normalize to uppercase server-side) | User-friendly for manual entry |
| Wrong code response | HTTP 403 `{"detail": "Invalid access code"}` | Distinguishable from 404 (room gone) and 500 (server error) |
| Room not found | HTTP 404 `{"detail": "Room not found or has ended"}` | Clear message for expired links |
| PIN vs PreJoin order | PIN screen first, then PreJoin | Don't make users configure camera only to be rejected |
| Creator redirect | Include `?code=` in redirect URL | Creator shouldn't hit their own PIN screen |
| Shareable link display | Intermediate screen after creation, before entering room | Creator must see/copy the link before joining |
| Code retrieval in-room | Visible in URL bar; optionally show in a small info tooltip | Simple, no extra UI needed |
| Brute force | Accepted risk (out of scope) | Short-lived rooms + non-adversarial context |
| Agent impact | None — agent ignores unknown metadata keys | Verified: `from_metadata()` uses `.get()` for style, direct access for agenda only |

## Acceptance Criteria

- [ ] `/api/room` returns `{ room_name, access_code }` and stores code in room metadata
- [ ] `/api/token` requires `access_code` param and validates against room metadata
- [ ] Wrong code returns 403; missing/expired room returns 404
- [ ] After room creation, frontend shows an intermediate "share" screen with copyable link + code
- [ ] Creator can click "Join Meeting" to enter the room (URL includes `?code=`)
- [ ] Visiting `/room/xyz?code=CORRECT` goes straight to PreJoin screen
- [ ] Visiting `/room/xyz` (no code) shows PIN entry screen first
- [ ] Wrong PIN shows inline error, preserves input for correction
- [ ] Agent continues to work without changes

## Implementation Plan

### Phase 1: Server Changes — `server/main.py`

**1a. Generate access code in `/api/room`**

```python
# server/main.py — inside create_room()
import secrets, string

def generate_access_code() -> str:
    chars = string.ascii_uppercase + string.digits
    code = ''.join(secrets.choice(chars) for _ in range(4))
    return f"MEET-{code}"

# In create_room handler:
access_code = generate_access_code()
room_metadata = json.dumps({
    "agenda": req.agenda,
    "style": req.style,
    "access_code": access_code,
})
# ... create room as before ...
return {"room_name": room_name, "access_code": access_code}
```

**1b. Add `access_code` to `TokenRequest` and validate in `/api/token`**

```python
# server/main.py
class TokenRequest(BaseModel):
    room_name: str
    participant_name: str
    access_code: str  # Required — no token without code

# In token handler:
# 1. Fetch room from LiveKit to get metadata
# 2. Parse metadata JSON, extract stored access_code
# 3. Compare (case-insensitive) against request access_code
# 4. If mismatch → HTTPException(403, "Invalid access code")
# 5. If room not found → HTTPException(404, "Room not found or has ended")
# 6. If match → issue token as before
```

Key detail: use `lk_api.room.list_rooms(names=[room_name])` to fetch room metadata. If empty list returned, room doesn't exist.

### Phase 2: Frontend Home Page — `frontend/app/page.tsx`

**2a. Show intermediate "share" screen after room creation**

After `createMeeting()` succeeds, instead of immediately calling `router.push()`:
- Store `roomName` and `accessCode` in component state
- Render a share screen showing:
  - The meeting title (from agenda)
  - The shareable link: `{window.location.origin}/room/{roomName}?code={accessCode}`
  - A "Copy Link" button (using `navigator.clipboard.writeText()`)
  - The access code displayed prominently (for sharing verbally)
  - A "Join Meeting" button that calls `router.push(/room/{roomName}?code={accessCode})`

```tsx
// New state
const [createdRoom, setCreatedRoom] = useState<{roomName: string, accessCode: string} | null>(null);

// In createMeeting success handler:
setCreatedRoom({ roomName: data.room_name, accessCode: data.access_code });
// Remove: router.push(...)

// New conditional render:
if (createdRoom) {
  return <ShareScreen roomName={createdRoom.roomName} accessCode={createdRoom.accessCode} agenda={agenda} />;
}
```

UI styling: match existing dark theme (`bg-gray-900`, `border-gray-700`, `text-white`, `bg-blue-600` buttons).

### Phase 3: Frontend Room Page — `frontend/app/room/[id]/page.tsx`

**3a. Read `?code=` from URL**

```tsx
import { useSearchParams } from 'next/navigation';
// Wrap component in <Suspense> (required by Next.js 14 for useSearchParams)

const searchParams = useSearchParams();
const codeFromUrl = searchParams.get('code');
```

**3b. Add PIN entry gate before PreJoin**

New state: `const [accessCode, setAccessCode] = useState<string | null>(codeFromUrl);`

If `accessCode` is null, render PIN entry screen:
- Simple form: text input for code + "Enter" button
- On submit: set `accessCode` state (actual validation happens at token fetch time)
- Error display if token fetch returns 403

If `accessCode` is set, render existing PreJoin flow.

**3c. Pass `access_code` to `fetchToken()`**

```tsx
async function fetchToken(roomName: string, participantName: string, accessCode: string): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      room_name: roomName,
      participant_name: participantName,
      access_code: accessCode,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (res.status === 403) throw new Error("Invalid access code");
    if (res.status === 404) throw new Error("This meeting has ended or doesn't exist");
    throw new Error(body?.detail ?? `Server error ${res.status}`);
  }
  return (await res.json()).token;
}
```

**3d. Handle 403 by returning user to PIN screen**

If `fetchToken` throws "Invalid access code":
- Clear `accessCode` state → PIN screen re-appears
- Show error message: "Incorrect code — please try again"

### Phase 4: Agent — No Changes

Verified: `MeetingState.from_metadata()` in `agent/monitor.py` reads `metadata["agenda"]` and `metadata.get("style", "moderate")`. The new `access_code` key is silently ignored.

## Files Changed

| File | Change |
|------|--------|
| [server/main.py](server/main.py) | Add `generate_access_code()`, update `/api/room` response, add validation to `/api/token` |
| [frontend/app/page.tsx](frontend/app/page.tsx) | Add share screen state + UI after room creation |
| [frontend/app/room/[id]/page.tsx](frontend/app/room/[id]/page.tsx) | Add `useSearchParams`, PIN entry gate, pass code to `fetchToken` |

## References

- Brainstorm: [docs/brainstorms/2026-03-01-shareable-meeting-links-brainstorm.md](docs/brainstorms/2026-03-01-shareable-meeting-links-brainstorm.md)
- LiveKit room API: `lk_api.room.list_rooms(names=[room_name])` returns room list with metadata
- Next.js `useSearchParams`: requires `<Suspense>` boundary in App Router
