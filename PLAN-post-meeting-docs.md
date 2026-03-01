# Plan: Post-Meeting Documents Page

## Overview

At the end of every meeting, Beat automatically generates a **meeting transcript** and a **summary**. During the meeting, participants can ask Beat to produce additional markdown documents (e.g. attendance sheet, action items list, custom trackers). After the meeting ends, participants are redirected to a post-meeting page that lets them browse and read all generated documents.

---

## Goals

1. **Automatic documents**: Beat always produces `transcript.md` and `summary.md` at meeting end.
2. **On-request documents**: Participants say *"Beat, take attendance"* / *"Beat, list all action items"* → Beat queues the request and produces the doc at meeting end.
3. **Custom documents**: Participants say *"Beat, keep a record of everyone's concerns"* → Beat uses the LLM to extract the requested information from the transcript.
4. **Post-meeting page**: `/post-meeting/[id]` — a clean document browser that fetches docs from the server and renders them as formatted markdown.
5. **Redirect**: When the meeting ends, the room page redirects to the post-meeting page instead of home.

---

## Architecture

```
Participant voice/chat
        │ "Beat, take attendance"
        ▼
  agent/main.py
  _detect_doc_request()          ← new: regex → DocRequest
  queued in MeetingState.doc_requests
        │
        │ (meeting ends)
        ▼
  agent/doc_generator.py         ← new file
  _generate_*_doc()              ← pure markdown builders
  _generate_custom_doc()         ← LLM call
  _upload_doc()                  ← httpx POST to server
        │
        ▼
  server/main.py
  POST /api/rooms/{id}/docs      ← new: writes file to disk
        │
        ▼
  server/data/rooms/{room_id}/
    transcript.md
    summary.md
    attendance.md                ← only if requested
    action-items.md              ← only if requested
    custom-concerns.md           ← only if requested
        │
        ▼
  GET /api/rooms/{id}/docs       ← new: returns doc list
  GET /api/rooms/{id}/docs/{f}   ← new: returns raw markdown
        │
        ▼
  frontend/app/post-meeting/[id]/page.tsx  ← new page
  DocBrowser component           ← file list + markdown viewer
```

---

## 1. Agent: Document Request Detection

### `agent/main.py`

#### 1.1 New: `DocumentRequest` dataclass

Add near the top of the file alongside other dataclasses / imports:

```python
from dataclasses import dataclass as _dataclass

@_dataclass
class DocumentRequest:
    doc_type: str   # "attendance" | "action_items" | "custom"
    description: str  # human-readable, used as LLM prompt hint for "custom"
    slug: str       # filename stem e.g. "attendance", "concerns"
```

#### 1.2 New: `_DOC_REQUEST_PATTERNS`

```python
_DOC_REQUEST_PATTERNS: list[tuple[re.Pattern, str, str, str]] = [
    # (pattern, doc_type, description, slug)
    (
        re.compile(r"\b(take|do|track|record)\s+(an?\s+)?attendance\b"),
        "attendance", "Record which participants attended the meeting", "attendance",
    ),
    (
        re.compile(r"\bheadcount\b"),
        "attendance", "Record which participants attended the meeting", "attendance",
    ),
    (
        re.compile(r"\b(list|track|note|collect)\s+(the\s+)?(all\s+)?action\s+items?\b"),
        "action_items", "Consolidated list of all action items from the meeting", "action-items",
    ),
    (
        re.compile(r"\b(make|write|create|prepare|generate)\s+(a\s+)?summary\b"),
        "summary", "Full meeting summary with key points and decisions", "summary",
    ),
]

# Catch-all for freeform custom requests:
# "Beat, keep a record of everyone's concerns"
# "Beat, note down the budget numbers"
_CUSTOM_DOC_PATTERN = re.compile(
    r"\b(keep\s+(a\s+)?(record|log|track|note)\s+of|"
    r"document|note\s+down|record\s+down)\b"
)
```

#### 1.3 New: `_detect_doc_request(text)`

```python
def _detect_doc_request(text: str) -> DocumentRequest | None:
    """Return a DocumentRequest if the utterance is asking Beat to produce a document."""
    normalized = " ".join(text.lower().split())
    for pattern, doc_type, description, slug in _DOC_REQUEST_PATTERNS:
        if pattern.search(normalized):
            return DocumentRequest(doc_type=doc_type, description=description, slug=slug)
    if _CUSTOM_DOC_PATTERN.search(normalized):
        # Use the original text as the description hint for the LLM
        slug = re.sub(r"[^a-z0-9]+", "-", normalized[:40]).strip("-")
        return DocumentRequest(doc_type="custom", description=text.strip(), slug=slug or "custom")
    return None
```

#### 1.4 Wire into `BeatFacilitatorAgent.llm_node`

Inside the name-addressed branch (from the passive mode plan), after skip/end checks:

```python
# --- Document request ---
doc_req = _detect_doc_request(latest_user_text)
if doc_req and self._room:
    # Avoid duplicate requests
    existing_slugs = {r.slug for r in self._meeting_state.doc_requests}
    if doc_req.slug not in existing_slugs:
        self._meeting_state.doc_requests.append(doc_req)
        logger.info("doc_request queued: type=%s slug=%s", doc_req.doc_type, doc_req.slug)
    yield f"Got it — I'll prepare that document at the end of the meeting."
    return
```

#### 1.5 Trigger document generation at meeting end

In `_monitoring_loop`, in the `current_item is None` branch, before `break`:

```python
# Generate and upload all documents
from doc_generator import generate_and_upload_all_docs
room_id = ctx.room.name
server_url = os.environ.get("SERVER_URL", "http://localhost:8000")
try:
    await generate_and_upload_all_docs(
        mistral_client=mistral_client,
        state=state,
        room_id=room_id,
        server_url=server_url,
    )
    # Notify frontend that docs are ready
    payload = json.dumps({"type": "docs_ready", "room_id": room_id}).encode()
    await ctx.room.local_participant.publish_data(payload, reliable=True, topic="agenda")
    logger.info("docs_ready signal sent for room %s", room_id)
except Exception:
    logger.exception("Document generation/upload failed")
```

Also trigger when the user explicitly ends the meeting via `_is_end_meeting_request` in `llm_node` and `_handle_chat_mention`. Refactor the end-meeting path into a shared `_end_meeting()` coroutine.

---

## 2. `agent/monitor.py` — Add `doc_requests` field

```python
@dataclass
class MeetingState:
    ...
    doc_requests: list = field(default_factory=list)  # list[DocumentRequest]
    participants_seen: dict = field(default_factory=dict)  # identity → first_seen timestamp
```

Also update `add_transcript` to track participants:

```python
def add_transcript(self, speaker: str, text: str):
    entry = {"speaker": speaker, "text": text, "timestamp": time.time()}
    ...
    # Track participant first/last seen
    now = time.time()
    if speaker not in self.participants_seen:
        self.participants_seen[speaker] = {"first_seen": now, "last_seen": now}
    else:
        self.participants_seen[speaker]["last_seen"] = now
```

---

## 3. New File: `agent/doc_generator.py`

This module handles all document generation and upload. Keep it separate from `main.py` for clarity and testability.

```python
"""Beat document generation — produces markdown files at meeting end."""

import logging
import time
from datetime import datetime, timezone

import httpx

logger = logging.getLogger("beat-your-meet.docs")


# ── Markdown builders (pure functions, no I/O) ─────────────────────────────

def build_transcript(state) -> str:
    """Format all item transcripts as a structured markdown document."""
    lines = [
        "# Meeting Transcript",
        f"**Date:** {datetime.now().strftime('%B %d, %Y')}",
        f"**Duration:** {state.total_meeting_minutes:.0f} minutes",
        "",
    ]
    for idx, item in enumerate(state.items):
        lines.append(f"## {item.topic}")
        lines.append(f"*Allocated: {item.duration_minutes} min — Actual: {item.actual_elapsed:.1f} min*")
        lines.append("")
        entries = state.item_transcripts.get(idx, [])
        if entries:
            for entry in entries:
                ts = datetime.fromtimestamp(entry["timestamp"]).strftime("%H:%M:%S")
                lines.append(f"**[{ts}] {entry['speaker']}:** {entry['text']}")
        else:
            lines.append("*No transcript recorded for this item.*")
        lines.append("")
    return "\n".join(lines)


def build_summary(state) -> str:
    """Format completed ItemNotes as a structured markdown summary."""
    lines = [
        "# Meeting Summary",
        f"**Date:** {datetime.now().strftime('%B %d, %Y')}",
        f"**Agenda:** {state.agenda_title}",
        f"**Duration:** {state.total_meeting_minutes:.0f} minutes",
        "",
    ]
    if not state.meeting_notes:
        lines.append("*No agenda items were completed with notes.*")
        return "\n".join(lines)

    for notes in state.meeting_notes:
        lines.append(f"## {notes.topic}")
        if notes.key_points:
            lines.append("### Key Points")
            for pt in notes.key_points:
                lines.append(f"- {pt}")
        if notes.decisions:
            lines.append("### Decisions")
            for d in notes.decisions:
                lines.append(f"- {d}")
        if notes.action_items:
            lines.append("### Action Items")
            for a in notes.action_items:
                lines.append(f"- [ ] {a}")
        lines.append("")
    return "\n".join(lines)


def build_attendance(state) -> str:
    """Build an attendance sheet from the participants_seen tracker."""
    lines = [
        "# Attendance",
        f"**Date:** {datetime.now().strftime('%B %d, %Y')}",
        f"**Meeting:** {state.agenda_title}",
        "",
        "| Participant | Joined | Last Active |",
        "|---|---|---|",
    ]
    for identity, times in sorted(state.participants_seen.items()):
        joined = datetime.fromtimestamp(times["first_seen"]).strftime("%H:%M:%S")
        last = datetime.fromtimestamp(times["last_seen"]).strftime("%H:%M:%S")
        lines.append(f"| {identity} | {joined} | {last} |")
    lines.append("")
    lines.append(f"**Total attendees:** {len(state.participants_seen)}")
    return "\n".join(lines)


def build_action_items(state) -> str:
    """Consolidate all action items from all meeting notes."""
    lines = [
        "# Action Items",
        f"**Meeting:** {state.agenda_title}",
        f"**Date:** {datetime.now().strftime('%B %d, %Y')}",
        "",
    ]
    found_any = False
    for notes in state.meeting_notes:
        if notes.action_items:
            found_any = True
            lines.append(f"## {notes.topic}")
            for item in notes.action_items:
                lines.append(f"- [ ] {item}")
            lines.append("")
    if not found_any:
        lines.append("*No action items were recorded.*")
    return "\n".join(lines)


async def build_custom(client, state, description: str) -> str:
    """Use the LLM to extract information matching the user's request."""
    full_transcript = "\n\n".join(
        f"### {state.items[idx].topic}\n" +
        "\n".join(f"{e['speaker']}: {e['text']}" for e in entries)
        for idx, entries in state.item_transcripts.items()
        if entries
    )
    prompt = (
        f"You are an assistant processing a meeting transcript.\n"
        f"The user asked you to: \"{description}\"\n\n"
        f"Meeting transcript:\n{full_transcript}\n\n"
        f"Produce a concise, well-structured markdown document that fulfils the user's request. "
        f"Use markdown headers, bullet points, and tables where appropriate. "
        f"Start with a # heading that names the document."
    )
    try:
        response = await client.chat.complete_async(
            model="mistral-small-latest",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=1024,
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        logger.error("Custom doc LLM call failed: %s", e)
        return f"# Custom Document\n\n*Could not generate document: {e}*"


# ── Upload ─────────────────────────────────────────────────────────────────

async def _upload(server_url: str, room_id: str, filename: str, title: str, content: str) -> None:
    """POST a markdown document to the server's doc storage endpoint."""
    url = f"{server_url}/api/rooms/{room_id}/docs"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, json={"filename": filename, "title": title, "content": content})
        resp.raise_for_status()
    logger.info("Uploaded %s for room %s (%d chars)", filename, room_id, len(content))


# ── Orchestrator ───────────────────────────────────────────────────────────

async def generate_and_upload_all_docs(mistral_client, state, room_id: str, server_url: str) -> None:
    """Generate all queued + automatic documents and upload them to the server."""

    # Always: transcript
    await _upload(server_url, room_id, "transcript.md", "Meeting Transcript", build_transcript(state))

    # Always: summary (uses ItemNotes accumulated during the meeting)
    await _upload(server_url, room_id, "summary.md", "Meeting Summary", build_summary(state))

    # On-request documents
    generated_slugs = {"transcript", "summary"}

    for req in state.doc_requests:
        if req.slug in generated_slugs:
            continue  # skip duplicates

        if req.doc_type == "attendance":
            content = build_attendance(state)
            title = "Attendance"
        elif req.doc_type == "action_items":
            content = build_action_items(state)
            title = "Action Items"
        elif req.doc_type == "summary":
            # User explicitly asked for summary — already generated above
            generated_slugs.add(req.slug)
            continue
        elif req.doc_type == "custom":
            content = await build_custom(mistral_client, state, req.description)
            title = req.description[:60]
        else:
            logger.warning("Unknown doc_type=%s, skipping", req.doc_type)
            continue

        filename = f"{req.slug}.md"
        await _upload(server_url, room_id, filename, title, content)
        generated_slugs.add(req.slug)
```

---

## 4. Server: Document Storage API

### `server/main.py` additions

#### 4.1 Storage path constant

```python
# Resolved to server/data/ regardless of CWD
_DATA_DIR = Path(__file__).resolve().parent / "data"
```

#### 4.2 Input models

```python
class UploadDocRequest(BaseModel):
    filename: str   # e.g. "transcript.md"
    title: str      # human display name
    content: str    # raw markdown

class DocMeta(BaseModel):
    filename: str
    title: str
    size_bytes: int
    created_at: str  # ISO 8601
```

#### 4.3 Security helper

**Path traversal must be prevented.** Room IDs and filenames are validated strictly before any filesystem operation.

```python
import re as _re

_ROOM_ID_RE = _re.compile(r"^meet-[a-f0-9]{8}$")
_FILENAME_RE = _re.compile(r"^[a-z0-9][a-z0-9-]{0,58}\.md$")

def _safe_room_dir(room_id: str) -> Path:
    """Validate room_id and return its data directory. Raises 400 on invalid input."""
    if not _ROOM_ID_RE.match(room_id):
        raise HTTPException(status_code=400, detail="Invalid room_id format")
    return _DATA_DIR / "rooms" / room_id

def _safe_doc_path(room_id: str, filename: str) -> Path:
    """Validate both room_id and filename, return the full path."""
    if not _FILENAME_RE.match(filename):
        raise HTTPException(status_code=400, detail="Invalid filename format")
    return _safe_room_dir(room_id) / filename
```

#### 4.4 New endpoints

```python
@app.post("/api/rooms/{room_id}/docs", status_code=201)
async def upload_doc(room_id: str, req: UploadDocRequest):
    """Agent uploads a generated markdown document."""
    path = _safe_doc_path(room_id, req.filename)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(req.content, encoding="utf-8")
    # Write companion metadata file
    meta_path = path.with_suffix(".meta.json")
    meta = {
        "filename": req.filename,
        "title": req.title,
        "size_bytes": len(req.content.encode("utf-8")),
        "created_at": datetime.utcnow().isoformat() + "Z",
    }
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    logger.info("Stored doc %s for room %s", req.filename, room_id)
    return {"ok": True}


@app.get("/api/rooms/{room_id}/docs")
async def list_docs(room_id: str) -> list[DocMeta]:
    """List all available documents for a room."""
    room_dir = _safe_room_dir(room_id)
    if not room_dir.exists():
        return []
    docs = []
    for meta_path in sorted(room_dir.glob("*.meta.json")):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            docs.append(DocMeta(**meta))
        except Exception:
            logger.warning("Could not read meta file %s", meta_path)
    return docs


@app.get("/api/rooms/{room_id}/docs/{filename}")
async def get_doc(room_id: str, filename: str) -> dict:
    """Fetch the raw markdown content of a specific document."""
    path = _safe_doc_path(room_id, filename)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Document not found")
    content = path.read_text(encoding="utf-8")
    # Read title from companion meta if available
    meta_path = path.with_suffix(".meta.json")
    title = filename
    if meta_path.exists():
        try:
            title = json.loads(meta_path.read_text())["title"]
        except Exception:
            pass
    return {"filename": filename, "title": title, "content": content}
```

**Add `datetime` import** to `server/main.py` (already has `json`, `Path`):
```python
from datetime import datetime
```

---

## 5. Frontend: Post-Meeting Page

### 5.1 New dependency

```bash
cd frontend
npm install react-markdown remark-gfm
```

`react-markdown` renders markdown as React components. `remark-gfm` adds GitHub Flavored Markdown support (tables, task lists, strikethrough).

### 5.2 Redirect from room page

In `frontend/app/room/[id]/page.tsx`, change the `meeting_ended` handler in `MeetingRoom` to redirect to the post-meeting page instead of home:

```tsx
// Before:
else if (data.type === "meeting_ended") router.push("/");

// After:
else if (data.type === "meeting_ended") {
  router.push(`/post-meeting/${roomName}?code=${accessCode}`);
}
```

Also handle the new `docs_ready` event — same redirect target:
```tsx
else if (data.type === "docs_ready") {
  router.push(`/post-meeting/${roomName}?code=${accessCode}`);
}
```

`roomName` and `accessCode` need to be accessible in `MeetingRoom`. Currently `roomName` comes from `useParams` in the parent. Thread it down as a prop or via a shared state/context.

### 5.3 New page: `frontend/app/post-meeting/[id]/page.tsx`

```
/post-meeting/[id]
  ├── Left panel (240px): document list
  │     Each doc shows its title and a file icon
  │     Active doc is highlighted
  └── Right panel (flex-1): markdown viewer
        Renders the selected document's content
        Shows a spinner while fetching
```

**Layout wireframe:**
```
┌─────────────────────────────────────────────────────┐
│  Beat Your Meet  ·  Meeting Documents        [Home]  │
├──────────────────┬──────────────────────────────────┤
│  DOCUMENTS       │  # Meeting Transcript             │
│                  │                                   │
│  ▶ Transcript    │  **Date:** March 1, 2026          │
│    Summary       │  **Duration:** 42 minutes         │
│    Attendance    │                                   │
│    Action Items  │  ## Product Roadmap               │
│                  │  *Allocated: 15 min — Actual: 18* │
│                  │                                   │
│                  │  **[10:04:22] Alice:** We should  │
│                  │  prioritise the mobile app...     │
└──────────────────┴──────────────────────────────────┘
```

**Component structure:**

```tsx
// app/post-meeting/[id]/page.tsx
"use client";
import { Suspense } from "react";
import PostMeetingPageInner from "./PostMeetingPageInner";

export default function PostMeetingPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <PostMeetingPageInner />
    </Suspense>
  );
}

// PostMeetingPageInner: handles data fetching + layout
// DocList: left panel component
// DocViewer: right panel markdown renderer
```

**Data fetching:**
- On mount: `GET /api/rooms/{id}/docs` → build the list
- On doc select: `GET /api/rooms/{id}/docs/{filename}` → fetch content
- Poll `GET /api/rooms/{id}/docs` every 3 seconds until at least one doc appears (agent may not have finished uploading instantly). Stop polling once docs are found.

**Access code:** passed via `?code=` query param (same pattern as the room page). Used only for validation if we add auth later — for now it is stored but not sent to the server (server allows unauthenticated reads of docs, as the room ID is a non-guessable UUID).

**Markdown rendering:**
```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  components={{
    // Style task list checkboxes, tables, code blocks etc.
    table: ({ children }) => (
      <div className="overflow-x-auto">
        <table className="doc-table">{children}</table>
      </div>
    ),
    input: ({ checked }) => (
      <input type="checkbox" checked={checked} readOnly className="mr-2" />
    ),
  }}
>
  {content}
</ReactMarkdown>
```

---

## 6. Env Variable

Add to `.env.example` and `.env`:

```
SERVER_URL=http://localhost:8000
```

The agent reads this to know where to POST documents. Defaults to `http://localhost:8000` if not set.

---

## 7. Files Created / Modified Summary

| File | Action | What changes |
|------|--------|-------------|
| `agent/doc_generator.py` | **Create** | All doc build + upload logic |
| `agent/main.py` | **Modify** | Add `DocumentRequest`, detection patterns, `_detect_doc_request()`, wire into `llm_node`, trigger generation at meeting end |
| `agent/monitor.py` | **Modify** | Add `doc_requests: list`, `participants_seen: dict`, update `add_transcript` to track speakers |
| `server/main.py` | **Modify** | Add `_DATA_DIR`, `_safe_room_dir/path`, `UploadDocRequest`, `DocMeta`, 3 new endpoints, `datetime` import |
| `frontend/app/room/[id]/page.tsx` | **Modify** | Handle `docs_ready`, redirect to `/post-meeting/{id}` instead of `/` |
| `frontend/app/post-meeting/[id]/page.tsx` | **Create** | Full post-meeting page |
| `frontend/app/post-meeting/[id]/PostMeetingPageInner.tsx` | **Create** | Data-fetching + layout component |
| `frontend/components/DocList.tsx` | **Create** | Left-panel doc list |
| `frontend/components/DocViewer.tsx` | **Create** | Right-panel markdown renderer |
| `.env.example` | **Modify** | Add `SERVER_URL` |
| `frontend/package.json` | **Modify** | Add `react-markdown`, `remark-gfm` |

---

## 8. Security Considerations

1. **Path traversal**: `_safe_room_dir` and `_safe_doc_path` strictly validate room ID and filename with regex before any `Path` join. No user-supplied string is ever passed to `Path` without validation.
2. **Room ID format**: `^meet-[a-f0-9]{8}$` — matches only the UUID-based IDs generated by `create_room`. An attacker cannot enumerate rooms without knowing a valid ID.
3. **Filename allowlist**: `^[a-z0-9][a-z0-9-]{0,58}\.md$` — lowercase alphanumeric + hyphens, `.md` suffix only. Rejects `../`, absolute paths, null bytes, etc.
4. **Content size**: Consider adding a `max_length` validator on `UploadDocRequest.content` (e.g. 500 KB) to prevent oversized payloads.
5. **Agent auth**: The doc upload endpoint is currently unauthenticated (internal service-to-service). For production, add an `X-Internal-Token` header validated against `INTERNAL_API_SECRET` from `.env`.
6. **CORS**: The new endpoints are covered by the existing `CORSMiddleware`. No change needed.
7. **No sensitive data leak**: Doc listing returns only filename, title, size, and creation time. Full content only fetched on demand.

---

## 9. Document Formats (canonical templates)

### `transcript.md`
```markdown
# Meeting Transcript
**Date:** March 1, 2026
**Duration:** 42 minutes

## Product Roadmap
*Allocated: 15 min — Actual: 18.2 min*

**[10:04:22] Alice:** We should prioritise the mobile app for Q2.
**[10:05:11] Bob:** Agreed — the web dashboard can wait.
...

## Budget Review
...
```

### `summary.md`
```markdown
# Meeting Summary
**Date:** March 1, 2026
**Agenda:** Q2 Planning

## Product Roadmap
### Key Points
- Mobile app prioritised for Q2
- Web dashboard deferred to Q3

### Decisions
- Allocate 3 engineers to mobile app from April

### Action Items
- [ ] Alice: Draft mobile app spec by Friday
- [ ] Bob: Update project board

## Budget Review
...
```

### `attendance.md`
```markdown
# Attendance
**Date:** March 1, 2026
**Meeting:** Q2 Planning

| Participant | Joined   | Last Active |
|---|---|---|
| Alice       | 10:02:14 | 10:44:58    |
| Bob         | 10:03:01 | 10:44:55    |
| Carol       | 10:07:40 | 10:30:12    |

**Total attendees:** 3
```

### `action-items.md`
```markdown
# Action Items
**Meeting:** Q2 Planning
**Date:** March 1, 2026

## Product Roadmap
- [ ] Alice: Draft mobile app spec by Friday
- [ ] Bob: Update project board

## Budget Review
- [ ] Carol: Send revised budget to CFO
```

---

## 10. Out of Scope (future work)

- **Document editing**: Post-meeting page is read-only. Editing is a future feature.
- **Download as PDF**: Could be added via `jsPDF` or a server-side render.
- **Email delivery**: Sending docs by email after the meeting.
- **Document TTL / cleanup**: Files currently persist indefinitely on disk. A cleanup job or expiry policy is a future concern.
- **Auth on doc reads**: Requiring the access code to read docs is optional — the room ID is already non-guessable.
- **Real-time doc preview**: Showing a "Beat is writing your summary..." loading state in-meeting.
