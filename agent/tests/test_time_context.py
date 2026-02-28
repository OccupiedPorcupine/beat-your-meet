import os
import sys
import unittest
from unittest.mock import patch


AGENT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if AGENT_DIR not in sys.path:
    sys.path.insert(0, AGENT_DIR)

from monitor import MeetingState  # noqa: E402
from prompts import FACILITATOR_SYSTEM_PROMPT, STYLE_INSTRUCTIONS  # noqa: E402


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


class TestMeetingTimeContext(unittest.TestCase):
    def test_context_includes_total_meeting_minutes(self):
        state = MeetingState.from_metadata(_metadata())

        with patch("monitor.time.time", return_value=1000.0):
            state.start_meeting()

        with patch("monitor.time.time", return_value=1300.0):
            ctx = state.get_context_for_prompt()

        self.assertIn("total_meeting_minutes", ctx)
        self.assertAlmostEqual(ctx["total_meeting_minutes"], 5.0, places=3)

    def test_start_time_transitions_from_not_started_after_start(self):
        state = MeetingState.from_metadata(_metadata())
        before = state.get_context_for_prompt()
        self.assertEqual(before["start_time"], "not started")

        with patch("monitor.time.time", return_value=1000.0):
            state.start_meeting()
            after = state.get_context_for_prompt()

        self.assertNotEqual(after["start_time"], "not started")

    def test_facilitator_prompt_renders_total_meeting_elapsed_line(self):
        state = MeetingState.from_metadata(_metadata())

        with patch("monitor.time.time", return_value=1000.0):
            state.start_meeting()
        with patch("monitor.time.time", return_value=1300.0):
            ctx = state.get_context_for_prompt()

        prompt = FACILITATOR_SYSTEM_PROMPT.format(
            style_instructions=STYLE_INSTRUCTIONS["moderate"],
            **ctx,
        )

        self.assertIn("Total meeting elapsed: 5.0 min", prompt)


if __name__ == "__main__":
    unittest.main()
