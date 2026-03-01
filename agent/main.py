"""Beat Your Meet — AI Meeting Facilitator Agent.

This agent joins a LiveKit room, transcribes all participants,
monitors conversation against the agenda, and barges in when
participants go off-topic or exceed their time box.
"""

import asyncio
import errno
import json
import logging
import os
import re
import socket
import sys
import time
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import AutoSubscribe, JobContext, RunContext, WorkerOptions, cli, function_tool, llm as lk_llm
from livekit.agents.voice import Agent, AgentSession
from livekit.plugins import deepgram, elevenlabs, openai, silero

from monitor import MeetingState, ItemState, ItemNotes, AgendaItem
from prompts import (
    ASSESS_CONVERSATION_TOOL,
    BOT_INTRO_TEMPLATE,
    CHATTING_INTRO_TEMPLATE,
    CHATTING_SYSTEM_PROMPT,
    AGENDA_TRANSITION_TEMPLATE,
    FACILITATOR_SYSTEM_PROMPT,
    ITEM_SUMMARY_TOOL,
    ITEM_SUMMARY_PROMPT,
    MONITORING_PROMPT,
    STYLE_INSTRUCTIONS,
    TIME_WARNING_TEMPLATE,
)
from multi_audio import MultiParticipantAudioInput
from speech_gate import (
    GateResult,
    Trigger,
    detect_silence_request,
    evaluate as gate_evaluate,
)

# Resolve absolute path to .env so it works regardless of CWD or how Python
# was invoked (e.g. `python main.py` vs running from the project root).
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logger = logging.getLogger("beat-your-meet")
logger.setLevel(logging.INFO)

_TRUTHY = {"1", "true", "yes", "on"}
_FALSEY = {"0", "false", "no", "off"}
_TIME_QUERY_PATTERNS = (
    re.compile(r"\bwhat(?:'s| is)?\s+time\b"),
    re.compile(r"\bwhat(?:'s| is)?\s+the\s+time\b"),
    re.compile(r"\bwhat\s+time\s+is\s+it\b"),
    re.compile(r"\bhow\s+long\s+has\s+this\s+meeting\b"),
    re.compile(r"\bhow\s+long\s+have\s+we\s+been\b"),
    re.compile(r"\bhow\s+much\s+time(?:\s+is)?\s+left\b"),
    re.compile(r"\btime\s+left\b"),
    re.compile(r"\bremaining\s+time\b"),
    re.compile(r"\bminutes?\s+left\b"),
)

_SKIP_PATTERNS = (
    re.compile(r"\bskip\s+(this|that|the\s+\w+|current)\b"),
    re.compile(r"\blet'?s?\s+skip\b"),
    re.compile(r"\bcan\s+we\s+skip\b"),
    re.compile(r"\bmove\s+on\s+to\s+the\s+next\b"),
    re.compile(r"\bnext\s+agenda\s+item\b"),
    re.compile(r"\bnext\s+topic\b"),
    re.compile(r"\bskip\s+ahead\b"),
)

_END_MEETING_PATTERNS = (
    re.compile(r"\bend\s+the\s+meeting\b"),
    re.compile(r"\bmeeting\s+is\s+(over|done|ended|finished)\b"),
    re.compile(r"\bmeeting'?s\s+(over|done|ended)\b"),
    re.compile(r"\blet'?s?\s+end\s+(the\s+)?meeting\b"),
    re.compile(r"\badjourn\b"),
    re.compile(r"\bthat'?s?\s+(it|all)\s+for\s+today\b"),
    re.compile(r"\bclose\s+(the\s+)?meeting\b"),
    re.compile(r"\bwe'?re?\s+done\s+(with\s+the\s+)?meeting\b"),
)


def _resolve_agent_port() -> int:
    """Resolve agent health-check port from AGENT_PORT with sane defaults."""
    raw = os.environ.get("AGENT_PORT", "8081")
    try:
        port = int(raw)
    except ValueError:
        logger.warning("Invalid AGENT_PORT=%r; defaulting to 8081", raw)
        return 8081

    if not (0 <= port <= 65535):
        logger.warning("Out-of-range AGENT_PORT=%r; defaulting to 8081", raw)
        return 8081
    return port


def _is_port_in_use(port: int) -> bool:
    """Return True when a TCP port is already bound on localhost."""
    if port == 0:
        return False

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("0.0.0.0", port))
            return False
        except OSError as exc:
            if exc.errno == errno.EADDRINUSE:
                return True
            raise


def _resolve_bool_env(name: str, default: bool) -> bool:
    """Resolve a bool env var from common truthy/falsey strings."""
    raw = os.environ.get(name)
    if raw is None:
        return default

    normalized = raw.strip().lower()
    if normalized in _TRUTHY:
        return True
    if normalized in _FALSEY:
        return False

    logger.warning(
        "Invalid %s=%r; expected one of %s or %s. Defaulting to %s.",
        name,
        raw,
        sorted(_TRUTHY),
        sorted(_FALSEY),
        default,
    )
    return default


def _extract_latest_user_text(chat_ctx: lk_llm.ChatContext) -> str:
    """Extract the most recent user text message from chat context."""
    for item in reversed(chat_ctx.items):
        if getattr(item, "type", None) != "message":
            continue
        if getattr(item, "role", None) != "user":
            continue
        text = getattr(item, "text_content", None)
        if text:
            return text
    return ""


def _is_time_query(text: str) -> bool:
    """Return True if the utterance is a direct meeting-time question."""
    normalized = " ".join(text.lower().split())
    if not normalized:
        return False
    return any(pattern.search(normalized) for pattern in _TIME_QUERY_PATTERNS)


def _is_skip_request(text: str) -> bool:
    """Return True if the utterance is a request to skip the current agenda item."""
    normalized = " ".join(text.lower().split())
    if not normalized:
        return False
    return any(pattern.search(normalized) for pattern in _SKIP_PATTERNS)


def _is_end_meeting_request(text: str) -> bool:
    """Return True if the utterance signals the meeting should end."""
    normalized = " ".join(text.lower().split())
    if not normalized:
        return False
    return any(pattern.search(normalized) for pattern in _END_MEETING_PATTERNS)


def _format_duration_for_tts(minutes: float) -> str:
    """Format minute float as concise speech-friendly duration text."""
    total_seconds = max(0, int(round(minutes * 60)))
    whole_minutes, seconds = divmod(total_seconds, 60)

    if whole_minutes and seconds:
        minute_word = "minute" if whole_minutes == 1 else "minutes"
        second_word = "second" if seconds == 1 else "seconds"
        return f"{whole_minutes} {minute_word} {seconds} {second_word}"
    if whole_minutes:
        minute_word = "minute" if whole_minutes == 1 else "minutes"
        return f"{whole_minutes} {minute_word}"
    second_word = "second" if seconds == 1 else "seconds"
    return f"{seconds} {second_word}"


def _format_time_status_for_tts(status: dict) -> str:
    """Create a concise deterministic spoken response for time queries."""
    if not status.get("meeting_started", False):
        return "The meeting clock has not started yet."

    clock_value = "unknown time"
    current_time_iso = status.get("current_time_iso")
    if isinstance(current_time_iso, str) and current_time_iso:
        try:
            dt = datetime.fromisoformat(current_time_iso)
            clock_value = dt.strftime("%I:%M %p").lstrip("0")
        except ValueError:
            clock_value = current_time_iso

    total_elapsed = _format_duration_for_tts(
        float(status.get("total_meeting_minutes", 0.0))
    )
    remaining = _format_duration_for_tts(
        float(status.get("current_item_remaining_minutes", 0.0))
    )
    topic = str(status.get("current_item_topic") or "the current item")
    allocated = float(status.get("current_item_allocated_minutes", 0.0))

    if topic == "none" or allocated <= 0:
        return f"It's {clock_value}. The meeting has run for {total_elapsed}, and there is no active agenda item right now."

    return (
        f"It's {clock_value}. The meeting has run for {total_elapsed}, "
        f"with {remaining} left on {topic}."
    )


class BeatFacilitatorAgent(Agent):
    """Agent wrapper that serves deterministic time answers without LLM calls
    and handles skip / end-meeting commands directly."""

    def __init__(
        self,
        *,
        meeting_state: MeetingState,
        deterministic_time_queries_enabled: bool,
        room: "rtc.Room | None" = None,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._meeting_state = meeting_state
        self._deterministic_time_queries_enabled = deterministic_time_queries_enabled
        self._room = room
        logger.info(
            "BeatFacilitatorAgent registered %d tools: %s",
            len(self.tools),
            [t.id for t in self.tools],
        )

    async def llm_node(self, chat_ctx, tools, model_settings):
        latest_user_text = _extract_latest_user_text(chat_ctx)
        is_time_query = _is_time_query(latest_user_text)

        if is_time_query and self._deterministic_time_queries_enabled:
            status = self._meeting_state.get_time_status()
            logger.info(
                "time_query_detected=true time_query_path=deterministic total_meeting_minutes=%.3f current_item_remaining_minutes=%.3f",
                float(status.get("total_meeting_minutes", 0.0)),
                float(status.get("current_item_remaining_minutes", 0.0)),
            )
            yield _format_time_status_for_tts(status)
            return

        if is_time_query:
            logger.info("time_query_detected=true time_query_path=llm")

        # --- Skip current agenda item ---
        if _is_skip_request(latest_user_text) and self._room:
            state = self._meeting_state
            current_topic = state.current_item.topic if state.current_item else None
            if current_topic:
                next_item = state.advance_to_next()
                asyncio.create_task(_send_agenda_state(self._room, state))
                asyncio.create_task(_refresh_agent_instructions(self, state))
                state.record_intervention()
                if next_item:
                    logger.info("skip_request: skipped '%s', moving to '%s'", current_topic, next_item.topic)
                    yield f"Sure, skipping {current_topic}. Moving on to {next_item.topic}."
                else:
                    logger.info("skip_request: skipped '%s', no more items", current_topic)
                    yield f"Sure, skipping {current_topic}. That was the last agenda item — great meeting everyone!"
                return

        # --- End meeting ---
        if _is_end_meeting_request(latest_user_text) and self._room:
            logger.info("end_meeting_request detected")
            payload = json.dumps({"type": "meeting_ended"}).encode()
            asyncio.create_task(
                self._room.local_participant.publish_data(payload, reliable=True, topic="agenda")
            )
            yield "Thanks everyone, it's been a great meeting! Take care and goodbye!"
            return

        if not is_time_query:
            logger.debug("time_query_detected=false")

        async for chunk in super().llm_node(chat_ctx, tools, model_settings):
            yield chunk

    # ------------------------------------------------------------------
    # Function tools — auto-discovered by LiveKit and exposed to the LLM
    # ------------------------------------------------------------------

    @function_tool()
    async def get_participant_count(self, context: RunContext) -> dict:
        """Get the current number of participants in the meeting room.

        Use this when someone asks how many people are in the meeting,
        who is here, or anything about attendance.
        """
        if not self._room:
            return {"participant_count": 0, "participants": []}
        participants = list(self._room.remote_participants.values())
        return {
            "participant_count": len(participants),
            "participants": [p.identity for p in participants],
        }

    @function_tool()
    async def get_meeting_info(self, context: RunContext) -> dict:
        """Get current meeting status including timing and progress.

        Use this when someone asks about meeting progress, how long the meeting
        has been running, what topic is being discussed, or the meeting style.
        """
        state = self._meeting_state
        item = state.current_item
        return {
            "agenda_title": state.agenda_title,
            "style": state.style,
            "current_item": item.topic if item else None,
            "current_item_description": item.description if item else None,
            "current_item_elapsed_minutes": round(state.elapsed_minutes, 1),
            "current_item_allocated_minutes": item.duration_minutes if item else 0,
            "total_meeting_minutes": round(state.total_meeting_minutes, 1),
            "total_scheduled_minutes": round(state.total_scheduled_minutes, 1),
            "meeting_overtime_minutes": round(state.meeting_overtime, 1),
            "items_completed": sum(1 for i in state.items if i.state == ItemState.COMPLETED),
            "items_remaining": len(state.remaining_items),
            "total_items": len(state.items),
        }

    @function_tool()
    async def get_agenda(self, context: RunContext) -> dict:
        """Get the full meeting agenda with all items and their current status.

        Use this when someone asks what's on the agenda, what topics are planned,
        or wants an overview of the meeting structure.
        """
        state = self._meeting_state
        return {
            "title": state.agenda_title,
            "items": [
                {
                    "id": item.id,
                    "topic": item.topic,
                    "description": item.description,
                    "duration_minutes": item.duration_minutes,
                    "state": item.state.value,
                    "actual_elapsed_minutes": round(item.actual_elapsed, 1),
                }
                for item in state.items
            ],
        }

    @function_tool()
    async def get_meeting_notes(self, context: RunContext) -> dict:
        """Get notes and summaries from completed agenda items.

        Use this when someone asks for a recap, summary, what was discussed,
        decisions made, or action items from earlier in the meeting.
        """
        state = self._meeting_state
        return {
            "notes": [
                {
                    "topic": n.topic,
                    "key_points": n.key_points,
                    "decisions": n.decisions,
                    "action_items": n.action_items,
                }
                for n in state.meeting_notes
            ],
        }


async def entrypoint(ctx: JobContext):
    try:
        logger.info("Connecting to room...")
        await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

        # Wait for the first human participant to join
        logger.info("Waiting for participant...")
        participant = await ctx.wait_for_participant()
        logger.info(f"Participant joined: {participant.identity}")

        # Parse room metadata for agenda and style
        logger.info("Parsing room metadata...")
        room_metadata = ctx.room.metadata
        if room_metadata:
            metadata = json.loads(room_metadata)
        else:
            # Fallback: no agenda configured, use defaults
            metadata = {
                "agenda": {
                    "title": "Meeting",
                    "items": [
                        {
                            "id": 1,
                            "topic": "Open Discussion",
                            "description": "General discussion",
                            "duration_minutes": 30,
                        }
                    ],
                },
                "style": "moderate",
            }

        # Initialize meeting state
        meeting_state = MeetingState.from_metadata(metadata)
        logger.info(
            f"Meeting state initialized: {len(meeting_state.items)} items, style={meeting_state.style}"
        )

        # Configure LLM (Mistral via OpenAI-compatible interface)
        mistral_llm = openai.LLM(
            model="mistral-large-latest",
            api_key=os.environ["MISTRAL_API_KEY"],
            base_url="https://api.mistral.ai/v1",
        )

        # Build system instructions
        if meeting_state.style == "chatting":
            instructions = CHATTING_SYSTEM_PROMPT
        else:
            ctx_data = meeting_state.get_context_for_prompt()
            instructions = FACILITATOR_SYSTEM_PROMPT.format(
                style_instructions=STYLE_INSTRUCTIONS.get(
                    meeting_state.style, STYLE_INSTRUCTIONS["moderate"]
                ),
                **ctx_data,
            )
        deterministic_time_queries_enabled = _resolve_bool_env(
            "DETERMINISTIC_TIME_QUERIES", default=True
        )
        logger.info(
            "Deterministic time query path enabled=%s",
            deterministic_time_queries_enabled,
        )

        # Create the voice agent and session
        logger.info("Creating voice agent (VAD + STT + LLM + TTS)...")
        agent = BeatFacilitatorAgent(
            instructions=instructions,
            vad=silero.VAD.load(),
            stt=deepgram.STT(model="nova-2", language="en"),
            llm=mistral_llm,
            tts=elevenlabs.TTS(
                model="eleven_turbo_v2_5",
            ),
            meeting_state=meeting_state,
            deterministic_time_queries_enabled=deterministic_time_queries_enabled,
            room=ctx.room,
        )

        session = AgentSession()

        # Track transcriptions for monitoring.
        # Audio is mixed from all participants, so we can't attribute speech
        # to a specific speaker. Use "participant" as a generic label — the
        # transcript is only used for tangent detection, not per-speaker tracking.
        @session.on("user_input_transcribed")
        def on_speech(event):
            if not event.is_final:
                return
            remote = list(ctx.room.remote_participants.values())
            speaker = remote[0].identity if len(remote) == 1 else "participant"
            meeting_state.add_transcript(speaker, event.transcript)
            if detect_silence_request(event.transcript):
                meeting_state.update_silence_signal()
                logger.info("[gate] Silence signal set by %s", speaker)
            logger.info(f"[{speaker}] {event.transcript}")

        # Shared Mistral client for chat @beat responses
        from mistralai import Mistral as _Mistral
        mistral_chat_client = _Mistral(api_key=os.environ["MISTRAL_API_KEY"])

        @ctx.room.on("data_received")
        def on_data_received(data: rtc.DataPacket):
            try:
                msg = json.loads(data.data.decode())

                # Style change from any participant
                if (
                    msg.get("type") == "set_style"
                    and msg.get("style") in ("gentle", "moderate", "chatting")
                ):
                    meeting_state.style = msg["style"]
                    logger.info(f"Style changed to {msg['style']}")
                    asyncio.create_task(_refresh_agent_instructions(agent, meeting_state))

                # @beat mention in the chat
                elif msg.get("type") == "chat_message" and not msg.get("is_agent"):
                    text = msg.get("text", "")
                    if text.strip().lower().startswith("@beat"):
                        question = text.strip()[5:].strip()  # strip "@beat"
                        sender = msg.get("sender", "someone")
                        asyncio.create_task(
                            _handle_chat_mention(
                                ctx.room, meeting_state, mistral_chat_client, agent, sender, question
                            )
                        )
            except Exception:
                logger.exception("Failed to handle data_received")

        # Use a custom audio input that mixes ALL participants' audio
        # instead of the default RoomIO which only listens to one participant.
        multi_audio = MultiParticipantAudioInput(ctx.room)
        session.input.audio = multi_audio

        # Start the session — RoomIO will skip its own audio input since
        # session.input.audio is already set.
        logger.info("Starting agent session...")
        await session.start(agent, room=ctx.room)

        # Start the meeting
        meeting_state.start_meeting()
        # Rebuild instructions now that the meeting clock is running.
        # This prevents stale initial context such as "not started".
        await _refresh_agent_instructions(
            agent,
            meeting_state,
        )

        # Deliver bot introduction
        if meeting_state.style == "chatting":
            intro = CHATTING_INTRO_TEMPLATE
        else:
            first_item = meeting_state.items[0] if meeting_state.items else None
            intro = BOT_INTRO_TEMPLATE.format(
                num_items=len(meeting_state.items),
                total_minutes=int(meeting_state.total_scheduled_minutes),
                first_item=first_item.topic if first_item else "the discussion",
            )
        await asyncio.sleep(2)  # Brief pause before intro
        await _guarded_say(session, meeting_state, intro, Trigger.INTRO)

        # Send initial agenda state to frontend via data channel
        await _send_agenda_state(ctx.room, meeting_state)

        # Start the monitoring loop — store reference to prevent garbage collection
        logger.info("Starting monitoring loop...")
        _monitor_task = asyncio.create_task(
            _monitoring_loop(session, ctx, meeting_state, agent)
        )

        def _on_monitor_done(t: asyncio.Task) -> None:
            if not t.cancelled() and t.exception() is not None:
                logger.error("Monitoring loop exited with an error", exc_info=t.exception())

        _monitor_task.add_done_callback(_on_monitor_done)

        logger.info("Beat Your Meet agent started successfully")

    except Exception:
        logger.exception("Agent entrypoint crashed")
        raise


async def _summarize_item(
    client: "Mistral",
    item: AgendaItem,
    transcript: str,
) -> ItemNotes:
    """Summarise a completed agenda item using Mistral Small + tool calling."""
    try:
        response = await client.chat.complete_async(
            model="mistral-small-latest",
            messages=[
                {
                    "role": "user",
                    "content": ITEM_SUMMARY_PROMPT.format(
                        topic=item.topic,
                        description=item.description,
                        transcript=transcript or "(no transcript recorded)",
                    ),
                }
            ],
            tools=[ITEM_SUMMARY_TOOL],
            tool_choice="any",
            temperature=0.2,
            max_tokens=512,
        )
        if response.choices[0].message.tool_calls:
            args = json.loads(
                response.choices[0].message.tool_calls[0].function.arguments
            )
            logger.info(f"Item summarization complete for '{item.topic}'")
            return ItemNotes(
                item_id=item.id,
                topic=item.topic,
                key_points=args.get("key_points", []),
                decisions=args.get("decisions", []),
                action_items=args.get("action_items", []),
            )
    except Exception as e:
        logger.error(f"Item summarization failed: {e}")
    # Fallback: empty notes
    return ItemNotes(item_id=item.id, topic=item.topic)


async def _handle_chat_mention(
    room: rtc.Room,
    state: MeetingState,
    client: "Mistral",
    agent: Agent,
    sender: str,
    question: str,
):
    """Handle an @beat chat mention — mirrors all voice capabilities."""

    async def _reply(text: str) -> None:
        payload = json.dumps({
            "type": "chat_message",
            "sender": "Beat",
            "text": text,
            "is_agent": True,
            "timestamp": time.time(),
        }).encode()
        try:
            await room.local_participant.publish_data(payload, reliable=True, topic="chat")
        except Exception:
            logger.exception("Failed to publish @beat chat response")

    # --- Skip current agenda item ---
    if _is_skip_request(question):
        current_topic = state.current_item.topic if state.current_item else None
        if current_topic:
            next_item = state.advance_to_next()
            await _send_agenda_state(room, state)
            await _refresh_agent_instructions(agent, state)
            state.record_intervention()
            if next_item:
                logger.info("chat skip: '%s' → '%s'", current_topic, next_item.topic)
                await _reply(f"Skipping {current_topic}. Moving on to {next_item.topic}.")
            else:
                logger.info("chat skip: '%s' was the last item", current_topic)
                await _reply(f"Skipping {current_topic}. That was the last agenda item — great meeting!")
        else:
            await _reply("There are no active agenda items to skip.")
        return

    # --- End meeting ---
    if _is_end_meeting_request(question):
        logger.info("chat end_meeting request from %s", sender)
        ended_payload = json.dumps({"type": "meeting_ended"}).encode()
        try:
            await room.local_participant.publish_data(ended_payload, reliable=True, topic="agenda")
        except Exception:
            logger.exception("Failed to publish meeting_ended via chat")
        await _reply("Thanks everyone, it's been a great meeting! Goodbye!")
        return

    # --- Time query (deterministic, no LLM needed) ---
    if _is_time_query(question):
        status = state.get_time_status()
        await _reply(_format_time_status_for_tts(status))
        return

    # --- General question → Mistral ---
    item = state.current_item
    ctx_summary = (
        f"Meeting style: {state.style}. "
        f"Current agenda item: '{item.topic}', "
        f"elapsed {state.elapsed_minutes:.1f} of {item.duration_minutes} min."
        if item
        else f"Meeting style: {state.style}. No active agenda item."
    )

    try:
        response = await client.chat.complete_async(
            model="mistral-small-latest",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are Beat, an AI meeting assistant replying in a text chat. "
                        f"{ctx_summary} "
                        "Be concise and helpful. 1–3 sentences max. Plain text only."
                    ),
                },
                {
                    "role": "user",
                    "content": question if question else "You were mentioned.",
                },
            ],
            temperature=0.4,
            max_tokens=200,
        )
        reply_text = response.choices[0].message.content.strip()
    except Exception:
        logger.exception("Chat @beat LLM call failed")
        reply_text = "Sorry, I couldn't process that right now."

    await _reply(reply_text)


async def _refresh_agent_instructions(
    agent: Agent,
    state: MeetingState,
):
    """Rebuild the facilitator system prompt and push it to the agent."""
    if state.style == "chatting":
        await agent.update_instructions(CHATTING_SYSTEM_PROMPT)
    else:
        ctx_data = state.get_context_for_prompt()
        new_instructions = FACILITATOR_SYSTEM_PROMPT.format(
            style_instructions=STYLE_INSTRUCTIONS.get(
                state.style, STYLE_INSTRUCTIONS["moderate"]
            ),
            **ctx_data,
        )
        await agent.update_instructions(new_instructions)
    logger.info(f"Agent instructions refreshed (style={state.style})")


async def _guarded_say(
    session: AgentSession,
    state: MeetingState,
    candidate_text: str,
    trigger: str,
    tangent_confidence: float = 0.0,
) -> bool:
    ctx = state.build_meeting_context(tangent_confidence=tangent_confidence)
    result: GateResult = gate_evaluate(candidate_text, trigger, ctx)
    logger.info(
        "[gate] trigger=%s action=%s confidence=%.2f reason=%s",
        trigger,
        result.action,
        result.confidence,
        result.reason,
    )
    if result.action == "speak":
        await session.say(result.text_for_tts, allow_interruptions=True)
        state.record_intervention()
        return True
    return False


async def _monitoring_loop(
    session: AgentSession,
    ctx: JobContext,
    state: MeetingState,
    agent: Agent,
):
    """Periodically check if conversation is on-track and handle time transitions."""

    # Mistral Small for fast monitoring checks
    from mistralai import Mistral

    mistral_client = Mistral(api_key=os.environ["MISTRAL_API_KEY"])

    check_interval = 15  # seconds between checks

    while True:
        await asyncio.sleep(check_interval)

        try:
            # In chatting mode skip all facilitation — just keep the UI in sync.
            if state.style == "chatting":
                await _refresh_agent_instructions(agent, state)
                await _send_agenda_state(ctx.room, state)
                continue

            # Check if meeting is over (no more items)
            if state.current_item is None:
                try:
                    await _guarded_say(
                        session,
                        state,
                        "That wraps up our agenda. Great meeting, everyone!",
                        Trigger.WRAP_UP,
                    )
                except Exception:
                    logger.exception("Failed to deliver meeting wrap-up")
                break

            # Check time-based state transitions
            new_state = state.check_time_state()

            if new_state == ItemState.WARNING:
                remaining = max(
                    0,
                    state.current_item.duration_minutes - state.elapsed_minutes,
                )
                warning = TIME_WARNING_TEMPLATE.format(
                    remaining=f"{remaining:.0f}",
                    topic=state.current_item.topic,
                )
                if state.can_intervene():
                    try:
                        await _guarded_say(
                            session,
                            state,
                            warning,
                            Trigger.TIME_WARNING,
                        )
                    except Exception:
                        logger.exception("Failed to deliver time warning")

            elif new_state == ItemState.OVERTIME:
                # Capture the completed item before advancing
                prev_index = state.current_item_index
                completed_item = state.current_item

                # Auto-advance to next item
                next_item = state.advance_to_next()
                if next_item:
                    transition = AGENDA_TRANSITION_TEMPLATE.format(
                        next_item=next_item.topic,
                        duration=int(next_item.duration_minutes),
                    )
                    try:
                        await _guarded_say(
                            session,
                            state,
                            transition,
                            Trigger.TRANSITION,
                        )
                    except Exception:
                        logger.exception("Failed to deliver agenda transition")

                # Summarise the completed item and refresh agent instructions
                if completed_item:
                    transcript = state.get_item_transcript(prev_index)
                    notes = await _summarize_item(mistral_client, completed_item, transcript)
                    state.meeting_notes.append(notes)
                    await _refresh_agent_instructions(agent, state)

                await _send_agenda_state(ctx.room, state)
                continue

            # Check for tangent detection
            transcript = state.get_recent_transcript(seconds=60)
            if transcript and state.can_intervene_for_tangent():
                assessment = await _check_tangent(
                    mistral_client, state, transcript
                )
                if assessment:
                    spoken = assessment.get("spoken_response", "")
                    confidence = assessment.get("confidence", 0.0)
                    if spoken:
                        try:
                            await _guarded_say(
                                session,
                                state,
                                spoken,
                                Trigger.TANGENT,
                                tangent_confidence=confidence,
                            )
                        except Exception:
                            logger.exception("Failed to deliver tangent intervention")

            # Refresh LLM system prompt so time context never goes stale
            await _refresh_agent_instructions(agent, state)

            # Send updated state to frontend
            await _send_agenda_state(ctx.room, state)

        except Exception:
            logger.exception("Monitoring loop iteration failed")


async def _check_tangent(
    client: "Mistral",
    state: MeetingState,
    transcript: str,
) -> dict | None:
    """Use Mistral Small to quickly assess if conversation is on-topic."""
    item = state.current_item
    if not item:
        return None

    try:
        response = await client.chat.complete_async(
            model="mistral-small-latest",
            messages=[
                {
                    "role": "system",
                    "content": f"You are monitoring a live meeting. Bot style: {state.style}. "
                    f"Current item elapsed: {state.elapsed_minutes:.1f} of {item.duration_minutes} min. "
                    f"Meeting overtime so far: {state.meeting_overtime:.1f} min.",
                },
                {
                    "role": "user",
                    "content": MONITORING_PROMPT.format(
                        current_topic=item.topic,
                        topic_description=item.description,
                        recent_transcript=transcript,
                    ),
                },
            ],
            tools=[ASSESS_CONVERSATION_TOOL],
            tool_choice="any",
            temperature=0.1,
            max_tokens=256,
        )

        if response.choices[0].message.tool_calls:
            args = json.loads(
                response.choices[0].message.tool_calls[0].function.arguments
            )
            logger.info(f"Tangent check: {args.get('status')} (confidence: {args.get('confidence', 0):.2f})")
            return args

    except Exception as e:
        logger.error(f"Tangent check failed: {e}")

    return None


async def _send_agenda_state(room: rtc.Room, state: MeetingState):
    """Send current agenda state to frontend via data channel."""
    now_epoch = time.time()
    payload = json.dumps(
        {
            "type": "agenda_state",
            "current_item_index": state.current_item_index,
            "items": [
                {
                    "id": item.id,
                    "topic": item.topic,
                    "duration_minutes": item.duration_minutes,
                    "state": item.state.value,
                    "actual_elapsed": item.actual_elapsed,
                }
                for item in state.items
            ],
            "elapsed_minutes": state.elapsed_minutes,
            "meeting_overtime": state.meeting_overtime,
            "total_meeting_minutes": state.total_meeting_minutes,
            "style": state.style,
            "server_now_epoch": now_epoch,
            "meeting_start_epoch": state.meeting_start_time,
            "item_start_epoch": state.item_start_time,
            "meeting_notes": [
                {
                    "item_id": n.item_id,
                    "topic": n.topic,
                    "key_points": n.key_points,
                    "decisions": n.decisions,
                    "action_items": n.action_items,
                }
                for n in state.meeting_notes
            ],
        }
    ).encode()

    try:
        await room.local_participant.publish_data(
            payload, reliable=True, topic="agenda"
        )
    except Exception as e:
        logger.warning(f"Failed to send agenda state: {e}")


if __name__ == "__main__":
    agent_port = _resolve_agent_port()
    if _is_port_in_use(agent_port):
        logger.error(
            "Agent startup blocked: TCP port %s is already in use. "
            "Stop the existing agent process or set AGENT_PORT=0 for an ephemeral port.",
            agent_port,
        )
        sys.exit(1)

    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, port=agent_port))
