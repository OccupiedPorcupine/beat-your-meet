import asyncio
import os
import sys
import unittest
from unittest.mock import patch


AGENT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if AGENT_DIR not in sys.path:
    sys.path.insert(0, AGENT_DIR)

from monitor import MeetingState  # noqa: E402

try:
    import main as main_module  # noqa: E402
    from livekit.agents import llm as lk_llm  # noqa: E402
except ModuleNotFoundError as exc:  # pragma: no cover - env-dependent
    main_module = None
    lk_llm = None
    MAIN_IMPORT_ERROR = exc
else:
    MAIN_IMPORT_ERROR = None


def _metadata() -> dict:
    return {
        "agenda": {
            "title": "Test Meeting",
            "items": [
                {
                    "id": 1,
                    "topic": "Status",
                    "description": "Weekly status updates",
                    "duration_minutes": 10,
                }
            ],
        },
        "style": "moderate",
    }


class TestMeetingStateTimeStatus(unittest.TestCase):
    def test_get_time_status_before_meeting_start(self):
        state = MeetingState.from_metadata(_metadata())
        status = state.get_time_status(now=1000.0)

        self.assertFalse(status["meeting_started"])
        self.assertEqual(status["total_meeting_minutes"], 0.0)
        self.assertEqual(status["current_item_elapsed_minutes"], 0.0)
        self.assertEqual(status["current_item_remaining_minutes"], 0.0)
        self.assertEqual(status["meeting_overtime_minutes"], 0.0)

    def test_get_time_status_after_start(self):
        state = MeetingState.from_metadata(_metadata())
        with patch("monitor.time.time", return_value=1000.0):
            state.start_meeting()

        status = state.get_time_status(now=1300.0)
        self.assertTrue(status["meeting_started"])
        self.assertAlmostEqual(status["total_meeting_minutes"], 5.0, places=3)
        self.assertAlmostEqual(status["current_item_elapsed_minutes"], 5.0, places=3)
        self.assertAlmostEqual(status["current_item_remaining_minutes"], 5.0, places=3)

    def test_get_time_status_clamps_remaining_to_zero(self):
        state = MeetingState.from_metadata(_metadata())
        with patch("monitor.time.time", return_value=1000.0):
            state.start_meeting()

        status = state.get_time_status(now=2200.0)
        self.assertEqual(status["current_item_remaining_minutes"], 0.0)

    def test_get_time_status_includes_active_item_overrun_in_overtime(self):
        state = MeetingState.from_metadata(_metadata())
        with patch("monitor.time.time", return_value=1000.0):
            state.start_meeting()
        state.meeting_overtime = 2.0

        status = state.get_time_status(now=1900.0)
        self.assertAlmostEqual(status["meeting_overtime_minutes"], 7.0, places=3)


@unittest.skipUnless(main_module is not None, f"main import unavailable: {MAIN_IMPORT_ERROR}")
class TestDeterministicTimeHelpers(unittest.TestCase):
    def test_resolve_bool_env_truthy_falsey_and_invalid(self):
        with patch.dict("os.environ", {"DETERMINISTIC_TIME_QUERIES": "yes"}, clear=False):
            self.assertTrue(
                main_module._resolve_bool_env("DETERMINISTIC_TIME_QUERIES", default=False)
            )
        with patch.dict("os.environ", {"DETERMINISTIC_TIME_QUERIES": "off"}, clear=False):
            self.assertFalse(
                main_module._resolve_bool_env("DETERMINISTIC_TIME_QUERIES", default=True)
            )
        with (
            patch.dict("os.environ", {"DETERMINISTIC_TIME_QUERIES": "wat"}, clear=False),
            patch.object(main_module.logger, "warning"),
        ):
            self.assertTrue(
                main_module._resolve_bool_env("DETERMINISTIC_TIME_QUERIES", default=True)
            )

    def test_is_time_query_positive_and_negative_cases(self):
        self.assertTrue(main_module._is_time_query("What time is it now?"))
        self.assertTrue(main_module._is_time_query("How long has this meeting been going?"))
        self.assertTrue(main_module._is_time_query("How much time left on this item?"))
        self.assertFalse(main_module._is_time_query("Can you summarize the decisions so far?"))

    def test_format_time_status_for_tts_not_started(self):
        text = main_module._format_time_status_for_tts(
            {
                "meeting_started": False,
                "current_time_iso": "2026-03-01T12:00:00+00:00",
                "total_meeting_minutes": 0.0,
                "current_item_remaining_minutes": 0.0,
                "current_item_topic": "none",
                "current_item_allocated_minutes": 0.0,
            }
        )
        self.assertIn("has not started", text.lower())

    def test_format_time_status_for_tts_started(self):
        text = main_module._format_time_status_for_tts(
            {
                "meeting_started": True,
                "current_time_iso": "2026-03-01T12:34:56+00:00",
                "total_meeting_minutes": 7.5,
                "current_item_remaining_minutes": 2.25,
                "current_item_topic": "Status",
                "current_item_allocated_minutes": 10.0,
            }
        )
        self.assertIn("meeting has run for", text.lower())
        self.assertIn("left on status", text.lower())


@unittest.skipUnless(main_module is not None, f"main import unavailable: {MAIN_IMPORT_ERROR}")
class TestDeterministicRouting(unittest.TestCase):
    def _build_chat_ctx(self, text: str):
        chat_ctx = lk_llm.ChatContext.empty()
        chat_ctx.add_message(role="user", content=text)
        return chat_ctx

    async def _collect_chunks(self, agen):
        return [chunk async for chunk in agen]

    def test_time_query_uses_deterministic_path(self):
        state = MeetingState.from_metadata(_metadata())
        with patch("monitor.time.time", return_value=1000.0):
            state.start_meeting()

        agent = main_module.BeatFacilitatorAgent(
            instructions="test",
            meeting_state=state,
            deterministic_time_queries_enabled=True,
        )
        chat_ctx = self._build_chat_ctx("What time is it?")

        chunks = asyncio.run(self._collect_chunks(agent.llm_node(chat_ctx, [], None)))
        self.assertEqual(len(chunks), 1)
        self.assertIn("meeting has run", chunks[0].lower())

    def test_non_time_query_falls_back_to_llm(self):
        state = MeetingState.from_metadata(_metadata())
        agent = main_module.BeatFacilitatorAgent(
            instructions="test",
            meeting_state=state,
            deterministic_time_queries_enabled=True,
        )
        chat_ctx = self._build_chat_ctx("Can you summarize key decisions?")

        async def fake_llm_node(_agent, _chat_ctx, _tools, _settings):
            yield "llm-fallback"

        with patch.object(main_module.Agent.default, "llm_node", new=fake_llm_node):
            chunks = asyncio.run(self._collect_chunks(agent.llm_node(chat_ctx, [], None)))
        self.assertEqual(chunks, ["llm-fallback"])

    def test_time_query_falls_back_to_llm_when_flag_disabled(self):
        state = MeetingState.from_metadata(_metadata())
        agent = main_module.BeatFacilitatorAgent(
            instructions="test",
            meeting_state=state,
            deterministic_time_queries_enabled=False,
        )
        chat_ctx = self._build_chat_ctx("How much time left?")

        async def fake_llm_node(_agent, _chat_ctx, _tools, _settings):
            yield "llm-fallback"

        with patch.object(main_module.Agent.default, "llm_node", new=fake_llm_node):
            chunks = asyncio.run(self._collect_chunks(agent.llm_node(chat_ctx, [], None)))
        self.assertEqual(chunks, ["llm-fallback"])


if __name__ == "__main__":
    unittest.main()
