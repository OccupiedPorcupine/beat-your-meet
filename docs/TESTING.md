# Beat Your Meet — Manual Testing Guide

_Generated: 2026-02-28_

## Services Status

| Service | URL | Status |
|---------|-----|--------|
| Frontend (Next.js) | http://localhost:3000 | ✅ Running |
| Server (FastAPI) | http://localhost:8000 | ✅ Running |
| Agent (LiveKit) | wss://beat-the-meet-99fsjf10.livekit.cloud | ✅ Registered |

---

## Test 1 — Health Check (API)

**Goal:** Verify the server is reachable and responding.

```bash
curl http://localhost:8000/api/health
```

**Expected:** `{"status":"ok"}`

---

## Test 2 — Agenda Generation

**Goal:** Verify Mistral LLM is reachable and returns a structured agenda.

1. Open http://localhost:3000
2. In the text area, paste:
   > "Weekly engineering standup: discuss sprint progress, blockers, and upcoming deployments."
3. Select **30 min** duration.
4. Click **Generate Agenda**.

**Expected:**
- A spinner shows "Generating agenda..."
- Within ~5 seconds the agenda appears with 3–6 items that sum to ≤ 30 minutes.
- Each item has a topic name, description, and duration.

**Failure signals:**
- Alert box saying "Failed to generate agenda" → server or Mistral API issue.
- Items with durations that wildly exceed 30 min → LLM prompt regression.

---

## Test 3 — Agenda Editor

**Goal:** Verify the user can customise agenda items before starting.

After agenda is generated (Test 2 must pass):

1. Edit one item's **topic name** — type something different.
2. Change one item's **duration** to a different value.
3. Add a new item using the "+ Add item" button (if present).
4. Delete an item.

**Expected:**
- Changes are reflected immediately in the UI.
- The total-minutes counter at the bottom of the editor updates to match.

**Known bug (low priority, #9 in bugs.md):** `agenda.total_minutes` passed to the server won't reflect your edits — only item-level durations are correct. The agenda display in-meeting will still be accurate.

---

## Test 4 — Facilitation Style Selection

**Goal:** Verify all three styles are selectable before room creation.

1. On the home page after agenda generation, find the **Style** selector.
2. Click **Gentle** → confirm it's highlighted.
3. Click **Moderate** → confirm it's highlighted and Gentle is not.
4. Click **Aggressive** → confirm it's highlighted.

**Expected:** Only one style is active at a time. The selection persists until "Create Meeting" is clicked.

---

## Test 5 — Room Creation and Join Flow

**Goal:** Verify a room is created in LiveKit and you land on the correct pre-join screen.

1. With an agenda generated (Test 2) and a style selected, click **Create Meeting**.
2. You should be redirected to `/room/meet-XXXXXXXX` (8 random hex chars).
3. The pre-join screen appears with:
   - Camera preview
   - Microphone selector
   - Username input field
   - "Join Meeting" button (disabled until username is typed)
4. Enter your name (e.g. `Alice`) and click **Join Meeting**.

**Expected:**
- Pre-join screen shows your camera feed.
- After clicking Join, you enter the video conference room.
- The floating **Agenda Panel** appears on the right side.

**Failure signals:**
- "Failed to create meeting room" alert → server/LiveKit API key issue.
- "Failed to join room" after entering name → token endpoint issue.
- Blank pre-join with no camera → browser camera permission denied.

---

## Test 6 — Agent Joins and Speaks

**Goal:** Verify the AI facilitator joins the room and delivers the intro.

After joining the room (Test 5):

1. Wait ~5–10 seconds for the agent to connect.
2. You should see a second participant appear in the grid (the AI bot).
3. The bot will speak an introduction, something like:
   > "Hi! I'm your AI meeting facilitator. We have X items on the agenda and Y minutes to cover them. Let's start with [first topic]."

**Expected:**
- Bot participant tile appears in the video grid.
- You hear the bot voice through your speakers.
- The **Agenda Panel** populates with the agenda items and shows the first item as "Active".

**Failure signals:**
- No second participant after 15 seconds → agent not running or not connecting (check agent logs).
- No audio from bot → ElevenLabs TTS issue or `ELEVEN_API_KEY` misconfigured.
- Agenda panel stays empty → data channel (`topic: "agenda"`) not reaching the frontend.

---

## Test 7 — Agenda Panel Display

**Goal:** Verify the floating agenda panel shows correct state.

1. While in the meeting room, look at the agenda panel (right side).
2. Confirm:
   - The active agenda item is visually distinct (highlighted/bold).
   - Other items show their topic names and durations.
   - An elapsed time counter or progress indicator is visible.
3. Click the **close button** on the panel — it should collapse.
4. Click the **agenda button** in the control bar — it should reopen.

**Expected:** Panel opens and closes correctly. Active item is clearly indicated.

---

## Test 8 — Tangent Detection (Off-Topic Intervention)

**Goal:** Verify the bot intervenes when conversation drifts off-topic.

1. Join a meeting with a specific agenda (e.g. "Sprint planning: story points and sprint goal").
2. Wait for the bot intro to finish.
3. Spend ~60 seconds talking about something **completely unrelated**, e.g.:
   > "So I watched this great movie last weekend, have you seen Dune Part 2? The cinematography is incredible..."
4. Wait for the next monitoring cycle (~15 seconds after your speech).

**Expected (with Moderate or Aggressive style):**
- The bot interrupts and redirects, e.g.:
  > "Let's bring it back to [topic]. We want to make sure we cover all the agenda items..."
- The bot does **not** interrupt if confidence is low (below 0.7 threshold).

**Style differences to test:**
- **Aggressive**: Should intervene within ~10 seconds of going off-topic.
- **Moderate**: Tolerates ~30 seconds before intervening.
- **Gentle**: May not intervene at all on mild tangents.

---

## Test 9 — Time Warning

**Goal:** Verify the bot warns when an agenda item is at 80% of its time limit.

This is easiest to test with a very short agenda item:

1. On the home page, generate a short agenda (15 min total).
2. Edit the first item to have **2 minute** duration.
3. Create the meeting and join.
4. After the item becomes active, wait approximately 1.5–2 minutes.

**Expected:**
- The bot says something like:
  > "Just a heads-up — we're running a bit short on time for [topic]. About 1 minute remaining."
- The agenda panel may show the item entering a "warning" state (color change).

---

## Test 10 — Agenda Item Advancement (Overtime)

**Goal:** Verify the bot auto-advances to the next item when time runs out.

Continuing from Test 9 (or repeat with a 2-minute first item):

1. After the time warning fires (~1.5 min), continue talking through the time limit.
2. When the item's duration expires (~2 min), the bot should advance automatically.

**Expected:**
- Bot says something like:
  > "Time's up for [topic]! Let's move on to [next topic] — we have X minutes for that."
- The agenda panel updates: previous item shows as "Completed", next item becomes "Active".
- `elapsed_minutes` and `meeting_overtime` values update in the panel.

---

## Test 11 — Multi-Participant Rooms

**Goal:** Verify the bot works with more than one human participant.

1. Create a meeting and join from **Browser A** as "Alice".
2. Copy the room URL from the address bar.
3. Open the URL in **Browser B** (incognito or different browser) and join as "Bob".

**Expected:**
- Both participant tiles appear in the video grid.
- The bot's agenda data channel updates reach both browsers (both should show the same agenda state in their respective panels).

**Known bug (#1 in bugs.md):** All transcript entries will be attributed to the first participant ("Alice") regardless of who actually spoke. This degrades tangent detection in multi-person sessions but does not break functionality.

---

## Test 12 — Intervention Cooldown

**Goal:** Verify the bot doesn't spam interventions back-to-back.

1. Join a meeting and deliberately go off-topic (Test 8).
2. After the bot intervenes, immediately go off-topic again.

**Expected:**
- The bot does **not** intervene a second time within 30 seconds of the first intervention.
- After the 30-second cooldown, a second off-topic comment may trigger another intervention.

---

## Quick API Tests (curl)

Run these from a terminal to verify individual backend endpoints:

```bash
# Health
curl http://localhost:8000/api/health

# Generate agenda (should return JSON with items array)
curl -s -X POST http://localhost:8000/api/agenda \
  -H "Content-Type: application/json" \
  -d '{"description": "Q1 planning meeting", "duration_minutes": 30}' | python3 -m json.tool

# Generate a token (should return {"token": "eyJ..."})
curl -s -X POST http://localhost:8000/api/token \
  -H "Content-Type: application/json" \
  -d '{"room_name": "test-room", "participant_name": "TestUser"}' | python3 -m json.tool
```

---

## Known Issues to Watch For

These bugs are already documented in `bugs.md` — don't spend time debugging them, just note whether they reproduce:

| # | What to look for | Severity |
|---|-----------------|----------|
| 1 | In multi-person rooms, only one speaker name appears in agent logs | High |
| 3 | All three styles intervene at same frequency (every 15s check regardless of tolerance) | High |
| 6 | Browser devtools shows `AgendaDisplay` re-rendering every 1 second | Medium |
| 7 | If agent crashes mid-meeting, monitoring loop may silently stop | Medium |
| 8 | Agenda panel flickers briefly to far left on first load | Medium |

---

## What to Note in Your Report

For each test, record:
- ✅ Pass / ❌ Fail / ⚠️ Partial
- What you saw vs what was expected
- Any console errors (open browser DevTools → Console before testing)
- Any errors in the agent terminal output
