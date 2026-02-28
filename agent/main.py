"""Beat Your Meet — AI Meeting Facilitator Agent.

This agent joins a LiveKit room, transcribes all participants,
monitors conversation against the agenda, and barges in when
participants go off-topic or exceed their time box.
"""

import asyncio
import json
import logging
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import AutoSubscribe, JobContext, WorkerOptions, cli, llm
from livekit.agents.voice import Agent, AgentSession
from livekit.plugins import deepgram, elevenlabs, openai, silero

from monitor import MeetingState, ItemState
from prompts import (
    ASSESS_CONVERSATION_TOOL,
    BOT_INTRO_TEMPLATE,
    AGENDA_TRANSITION_TEMPLATE,
    FACILITATOR_SYSTEM_PROMPT,
    MONITORING_PROMPT,
    STYLE_INSTRUCTIONS,
    TIME_WARNING_TEMPLATE,
)

# Resolve absolute path to .env so it works regardless of CWD or how Python
# was invoked (e.g. `python main.py` vs running from the project root).
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logger = logging.getLogger("beat-your-meet")
logger.setLevel(logging.INFO)


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
        ctx_data = meeting_state.get_context_for_prompt()
        instructions = FACILITATOR_SYSTEM_PROMPT.format(
            style_instructions=STYLE_INSTRUCTIONS.get(
                meeting_state.style, STYLE_INSTRUCTIONS["moderate"]
            ),
            **ctx_data,
        )

        # Create the voice agent and session
        logger.info("Creating voice agent (VAD + STT + LLM + TTS)...")
        agent = Agent(
            instructions=instructions,
            vad=silero.VAD.load(),
            stt=deepgram.STT(model="nova-2", language="en"),
            llm=mistral_llm,
            tts=elevenlabs.TTS(
                model="eleven_turbo_v2_5",
            ),
        )

        session = AgentSession()

        # Track transcriptions for monitoring
        @session.on("user_input_transcribed")
        def on_speech(event):
            if not event.is_final:
                return
            # Best-effort speaker identification: if exactly one remote participant
            # is present use their identity; otherwise fall back to the first joiner.
            remote = list(ctx.room.remote_participants.values())
            speaker = remote[0].identity if len(remote) == 1 else participant.identity
            meeting_state.add_transcript(speaker, event.transcript)
            logger.info(f"[{speaker}] {event.transcript}")

        # Start the session
        logger.info("Starting agent session...")
        await session.start(agent, room=ctx.room)

        # Start the meeting
        meeting_state.start_meeting()

        # Deliver bot introduction
        first_item = meeting_state.items[0] if meeting_state.items else None
        intro = BOT_INTRO_TEMPLATE.format(
            num_items=len(meeting_state.items),
            total_minutes=int(meeting_state.total_scheduled_minutes),
            first_item=first_item.topic if first_item else "the discussion",
        )
        await asyncio.sleep(2)  # Brief pause before intro
        await session.say(intro, allow_interruptions=True)

        # Send initial agenda state to frontend via data channel
        await _send_agenda_state(ctx.room, meeting_state)

        # Start the monitoring loop — store reference to prevent garbage collection
        logger.info("Starting monitoring loop...")
        _monitor_task = asyncio.create_task(_monitoring_loop(session, ctx, meeting_state))

        def _on_monitor_done(t: asyncio.Task) -> None:
            if not t.cancelled() and t.exception() is not None:
                logger.error("Monitoring loop exited with an error", exc_info=t.exception())

        _monitor_task.add_done_callback(_on_monitor_done)

        logger.info("Beat Your Meet agent started successfully")

    except Exception:
        logger.exception("Agent entrypoint crashed")
        raise


async def _monitoring_loop(
    session: AgentSession,
    ctx: JobContext,
    state: MeetingState,
):
    """Periodically check if conversation is on-track and handle time transitions."""

    # Mistral Small for fast monitoring checks
    from mistralai import Mistral

    mistral_client = Mistral(api_key=os.environ["MISTRAL_API_KEY"])

    check_interval = 15  # seconds between checks

    while True:
        await asyncio.sleep(check_interval)

        try:
            # Check if meeting is over (no more items)
            if state.current_item is None:
                try:
                    await session.say(
                        "That wraps up our agenda. Great meeting, everyone!",
                        allow_interruptions=True,
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
                        await session.say(warning, allow_interruptions=True)
                        state.record_intervention()
                    except Exception:
                        logger.exception("Failed to deliver time warning")

            elif new_state == ItemState.OVERTIME:
                # Auto-advance to next item
                next_item = state.advance_to_next()
                if next_item:
                    transition = AGENDA_TRANSITION_TEMPLATE.format(
                        next_item=next_item.topic,
                        duration=int(next_item.duration_minutes),
                    )
                    try:
                        await session.say(transition, allow_interruptions=True)
                        state.record_intervention()
                    except Exception:
                        logger.exception("Failed to deliver agenda transition")
                await _send_agenda_state(ctx.room, state)
                continue

            # Check for tangent detection — use style-specific tolerance so gentle/aggressive
            # styles actually behave differently (bug: TANGENT_TOLERANCE was defined but unused)
            transcript = state.get_recent_transcript(seconds=60)
            if transcript and state.can_intervene_for_tangent():
                assessment = await _check_tangent(
                    mistral_client, state, transcript
                )
                if assessment and assessment.get("should_speak"):
                    spoken = assessment.get("spoken_response", "")
                    if spoken:
                        try:
                            await session.say(spoken, allow_interruptions=True)
                            state.record_intervention()
                        except Exception:
                            logger.exception("Failed to deliver tangent intervention")

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

    ctx_data = state.get_context_for_prompt()

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
            # Only intervene on high confidence off-topic assessments
            if args.get("confidence", 0) < 0.7:
                args["should_speak"] = False
            return args

    except Exception as e:
        logger.error(f"Tangent check failed: {e}")

    return None


async def _send_agenda_state(room: rtc.Room, state: MeetingState):
    """Send current agenda state to frontend via data channel."""
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
        }
    ).encode()

    try:
        await room.local_participant.publish_data(
            payload, reliable=True, topic="agenda"
        )
    except Exception as e:
        logger.warning(f"Failed to send agenda state: {e}")


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
