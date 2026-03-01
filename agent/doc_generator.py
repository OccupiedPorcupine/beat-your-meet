"""Beat document generation — produces markdown files at meeting end."""

import logging
from datetime import datetime

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
        lines.append(
            f"*Allocated: {item.duration_minutes} min — Actual: {item.actual_elapsed:.1f} min*"
        )
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
        f"### {state.items[idx].topic}\n"
        + "\n".join(f"{e['speaker']}: {e['text']}" for e in entries)
        for idx, entries in state.item_transcripts.items()
        if entries
    )
    prompt = (
        "You are an assistant processing a meeting transcript.\n"
        f'The user asked you to: "{description}"\n\n'
        f"Meeting transcript:\n{full_transcript}\n\n"
        "Produce a concise, well-structured markdown document that fulfils the user's request. "
        "Use markdown headers, bullet points, and tables where appropriate. "
        "Start with a # heading that names the document."
    )
    try:
        response = await client.chat.complete_async(
            model="mistral-small-latest",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=1024,
        )
        return response.choices[0].message.content.strip()
    except Exception as exc:
        logger.error("Custom doc LLM call failed: %s", exc)
        return f"# Custom Document\n\n*Could not generate document: {exc}*"


# ── Upload ─────────────────────────────────────────────────────────────────


async def _upload(
    server_url: str, room_id: str, filename: str, title: str, content: str
) -> None:
    """POST a markdown document to the server's doc storage endpoint."""
    url = f"{server_url}/api/rooms/{room_id}/docs"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            url, json={"filename": filename, "title": title, "content": content}
        )
        resp.raise_for_status()
    logger.info("Uploaded %s for room %s (%d chars)", filename, room_id, len(content))


# ── Orchestrator ───────────────────────────────────────────────────────────


async def generate_and_upload_all_docs(
    mistral_client, state, room_id: str, server_url: str
) -> None:
    """Generate all queued + automatic documents and upload them to the server."""

    # Always: transcript
    await _upload(
        server_url, room_id, "transcript.md", "Meeting Transcript", build_transcript(state)
    )

    # Always: summary (uses ItemNotes accumulated during the meeting)
    await _upload(
        server_url, room_id, "summary.md", "Meeting Summary", build_summary(state)
    )

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
