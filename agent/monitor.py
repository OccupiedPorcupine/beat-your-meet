"""Agenda state machine and conversation monitoring."""

import json
import time
from datetime import datetime, timezone
from enum import Enum
from dataclasses import dataclass, field


class ItemState(Enum):
    UPCOMING = "upcoming"
    ACTIVE = "active"
    WARNING = "warning"
    OVERTIME = "overtime"
    EXTENDED = "extended"
    COMPLETED = "completed"


@dataclass
class ItemNotes:
    item_id: int
    topic: str
    key_points: list[str] = field(default_factory=list)
    decisions: list[str] = field(default_factory=list)
    action_items: list[str] = field(default_factory=list)


@dataclass
class AgendaItem:
    id: int
    topic: str
    description: str
    duration_minutes: float
    state: ItemState = ItemState.UPCOMING
    actual_elapsed: float = 0.0


@dataclass
class MeetingState:
    agenda_title: str
    items: list[AgendaItem]
    style: str  # "gentle" | "moderate" | "chatting"
    current_item_index: int = 0
    item_start_time: float | None = None
    meeting_start_time: float | None = None
    meeting_overtime: float = 0.0
    last_intervention_time: float = 0.0
    last_override_time: float = 0.0
    silence_requested_until: float = 0.0
    override_grace_seconds: float = 120.0
    transcript_buffer: list[dict] = field(default_factory=list)
    item_transcripts: dict[int, list[dict]] = field(default_factory=dict)
    meeting_notes: list[ItemNotes] = field(default_factory=list)

    # Tangent tolerance per style (seconds). "chatting" disables tangent checks entirely.
    TANGENT_TOLERANCE = {
        "gentle": 60,
        "moderate": 30,
    }

    INTERVENTION_COOLDOWN = 30  # seconds between interventions

    @classmethod
    def from_metadata(cls, metadata: dict) -> "MeetingState":
        """Create MeetingState from LiveKit room metadata."""
        agenda = metadata["agenda"]
        items = [
            AgendaItem(
                id=item["id"],
                topic=item["topic"],
                description=item.get("description", ""),
                duration_minutes=item["duration_minutes"],
            )
            for item in agenda["items"]
        ]
        return cls(
            agenda_title=agenda.get("title", "Meeting"),
            items=items,
            style=metadata.get("style", "moderate"),
        )

    def start_meeting(self):
        """Start the meeting and activate the first agenda item."""
        now = time.time()
        self.meeting_start_time = now
        self.item_start_time = now
        if self.items:
            self.items[0].state = ItemState.ACTIVE

    @property
    def current_item(self) -> AgendaItem | None:
        if 0 <= self.current_item_index < len(self.items):
            return self.items[self.current_item_index]
        return None

    @property
    def remaining_items(self) -> list[AgendaItem]:
        return [
            item
            for item in self.items[self.current_item_index + 1 :]
            if item.state == ItemState.UPCOMING
        ]

    @property
    def elapsed_minutes(self) -> float:
        if self.item_start_time is None:
            return 0.0
        return (time.time() - self.item_start_time) / 60.0

    @property
    def total_meeting_minutes(self) -> float:
        if self.meeting_start_time is None:
            return 0.0
        return (time.time() - self.meeting_start_time) / 60.0

    @property
    def total_scheduled_minutes(self) -> float:
        return sum(item.duration_minutes for item in self.items)

    def check_time_state(self) -> ItemState | None:
        """Check if the current item needs a state transition based on time.
        Returns the new state if a transition occurred, None otherwise."""
        item = self.current_item
        if item is None or item.state == ItemState.COMPLETED:
            return None

        elapsed = self.elapsed_minutes
        allocated = item.duration_minutes
        pct = elapsed / allocated if allocated > 0 else 1.0

        old_state = item.state

        if pct >= 1.0 and item.state not in (ItemState.OVERTIME, ItemState.EXTENDED):
            item.state = ItemState.OVERTIME
        elif pct >= 0.8 and item.state == ItemState.ACTIVE:
            item.state = ItemState.WARNING

        return item.state if item.state != old_state else None

    def advance_to_next(self) -> AgendaItem | None:
        """Complete current item and move to the next one.
        Returns the new current item, or None if meeting is over."""
        item = self.current_item
        if item:
            # Track overtime for this item
            elapsed = self.elapsed_minutes
            overrun = max(0, elapsed - item.duration_minutes)
            self.meeting_overtime += overrun
            item.actual_elapsed = elapsed
            item.state = ItemState.COMPLETED

        self.current_item_index += 1
        next_item = self.current_item
        if next_item:
            next_item.state = ItemState.ACTIVE
            self.item_start_time = time.time()
            return next_item
        return None

    def handle_override(self):
        """Host says 'keep going' — suppress bot for grace period."""
        item = self.current_item
        if item:
            item.state = ItemState.EXTENDED
        self.last_override_time = time.time()

    def is_in_override_grace(self) -> bool:
        """Check if we're still in the grace period after a host override."""
        if self.last_override_time == 0:
            return False
        return (time.time() - self.last_override_time) < self.override_grace_seconds

    def update_silence_signal(self):
        """Called when a silence phrase is detected in participant speech."""
        self.silence_requested_until = time.time() + 120

    def build_meeting_context(self, tangent_confidence: float = 0.0) -> "MeetingContext":
        """Build a MeetingContext snapshot for speech gate evaluation."""
        from speech_gate import MeetingContext

        item = self.current_item
        return MeetingContext(
            style=self.style,
            current_topic=item.topic if item else "",
            current_item_state=item.state.value if item else "none",
            elapsed_minutes=self.elapsed_minutes,
            allocated_minutes=item.duration_minutes if item else 0.0,
            meeting_overtime=self.meeting_overtime,
            recent_transcript=self.get_recent_transcript(seconds=60),
            in_override_grace=self.is_in_override_grace(),
            silence_until=self.silence_requested_until,
            tangent_confidence=tangent_confidence,
            items_remaining=len(self.remaining_items),
        )

    def can_intervene(self) -> bool:
        """Check if enough time has passed since last intervention."""
        if self.is_in_override_grace():
            return False
        return (time.time() - self.last_intervention_time) > self.INTERVENTION_COOLDOWN

    def can_intervene_for_tangent(self) -> bool:
        """Check if enough time has passed since last intervention, using style-specific tolerance.

        gentle=60s, moderate=30s. "chatting" mode never triggers tangent checks.
        The tolerance is the minimum number of seconds that must have elapsed since
        the last intervention before the bot will speak up about a tangent.
        """
        if self.style == "chatting":
            return False
        if self.is_in_override_grace():
            return False
        tolerance = self.TANGENT_TOLERANCE.get(self.style, self.INTERVENTION_COOLDOWN)
        return (time.time() - self.last_intervention_time) > tolerance

    def record_intervention(self):
        """Record that the bot just spoke."""
        self.last_intervention_time = time.time()

    def add_transcript(self, speaker: str, text: str):
        """Add a transcript entry to the buffer."""
        entry = {"speaker": speaker, "text": text, "timestamp": time.time()}
        self.transcript_buffer.append(entry)
        # Dual-write to per-item store (full, no truncation)
        idx = self.current_item_index
        self.item_transcripts.setdefault(idx, []).append(entry)
        # Keep only last 2 minutes in the rolling buffer
        cutoff = time.time() - 120
        self.transcript_buffer = [
            t for t in self.transcript_buffer if t["timestamp"] > cutoff
        ]

    def get_recent_transcript(self, seconds: int = 60) -> str:
        """Get recent transcript as a string."""
        cutoff = time.time() - seconds
        recent = [t for t in self.transcript_buffer if t["timestamp"] > cutoff]
        return "\n".join(f"{t['speaker']}: {t['text']}" for t in recent)

    def get_item_transcript(self, item_index: int) -> str:
        """Return the full transcript for an agenda item as a formatted string."""
        entries = self.item_transcripts.get(item_index, [])
        return "\n".join(f"{e['speaker']}: {e['text']}" for e in entries)

    def get_memory_context(self) -> str:
        """Format all completed item notes for injection into the system prompt."""
        if not self.meeting_notes:
            return "No completed items yet."
        parts = []
        for notes in self.meeting_notes:
            section = [f"### {notes.topic}"]
            if notes.key_points:
                section.append("Key points: " + "; ".join(notes.key_points))
            if notes.decisions:
                section.append("Decisions: " + "; ".join(notes.decisions))
            if notes.action_items:
                section.append("Action items: " + "; ".join(notes.action_items))
            parts.append("\n".join(section))
        return "\n\n".join(parts)

    def get_time_status(self, now: float | None = None) -> dict:
        """Return a deterministic snapshot of meeting timing values.

        `now` is accepted for deterministic tests; if omitted, current wall time
        is used.
        """
        current_time = time.time() if now is None else now
        current_time_iso = (
            datetime.fromtimestamp(current_time, tz=timezone.utc)
            .astimezone()
            .isoformat(timespec="seconds")
        )
        item = self.current_item

        if self.meeting_start_time is None:
            return {
                "meeting_started": False,
                "current_time_iso": current_time_iso,
                "total_meeting_minutes": 0.0,
                "current_item_topic": item.topic if item else "none",
                "current_item_elapsed_minutes": 0.0,
                "current_item_remaining_minutes": 0.0,
                "current_item_allocated_minutes": item.duration_minutes if item else 0.0,
                "meeting_overtime_minutes": 0.0,
            }

        total_meeting_minutes = max(0.0, (current_time - self.meeting_start_time) / 60.0)
        current_item_allocated_minutes = item.duration_minutes if item else 0.0
        current_item_elapsed_minutes = (
            max(0.0, (current_time - self.item_start_time) / 60.0)
            if item and self.item_start_time is not None
            else 0.0
        )
        current_item_remaining_minutes = max(
            0.0, current_item_allocated_minutes - current_item_elapsed_minutes
        )
        active_item_overtime = max(
            0.0, current_item_elapsed_minutes - current_item_allocated_minutes
        )

        return {
            "meeting_started": True,
            "current_time_iso": current_time_iso,
            "total_meeting_minutes": total_meeting_minutes,
            "current_item_topic": item.topic if item else "none",
            "current_item_elapsed_minutes": current_item_elapsed_minutes,
            "current_item_remaining_minutes": current_item_remaining_minutes,
            "current_item_allocated_minutes": current_item_allocated_minutes,
            "meeting_overtime_minutes": self.meeting_overtime + active_item_overtime,
        }

    def get_context_for_prompt(self) -> dict:
        """Get current state formatted for Mistral prompts."""
        item = self.current_item
        return {
            "agenda_json": json.dumps(
                [
                    {
                        "id": i.id,
                        "topic": i.topic,
                        "duration": i.duration_minutes,
                        "state": i.state.value,
                    }
                    for i in self.items
                ],
                indent=2,
            ),
            "start_time": (
                time.strftime("%H:%M", time.localtime(self.meeting_start_time))
                if self.meeting_start_time
                else "not started"
            ),
            "current_time": time.strftime("%H:%M"),
            "current_item": item.topic if item else "none",
            "allocated_minutes": item.duration_minutes if item else 0,
            "elapsed_minutes": self.elapsed_minutes,
            "total_meeting_minutes": self.total_meeting_minutes,
            "remaining_items": ", ".join(i.topic for i in self.remaining_items) or "none",
            "meeting_overtime": self.meeting_overtime,
            "style": self.style,
            "current_topic": item.topic if item else "",
            "topic_description": item.description if item else "",
            "recent_transcript": self.get_recent_transcript(),
            "meeting_memory": self.get_memory_context(),
        }
