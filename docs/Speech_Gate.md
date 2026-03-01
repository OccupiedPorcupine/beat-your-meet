Ready to code?
                                                                                      
 Here is Claude's plan:
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Speech Gate — Implementation Plan                      

 Context

 The AI facilitator currently calls session.say() at five points in the monitoring
 loop with ad-hoc gating scattered across the code (cooldown checks, a hardcoded 0.7
 confidence threshold, is_in_override_grace()). There is no centralised, auditable
 decision point controlling when the bot should speak. Participants have no way to
 silence the bot at runtime, and style-specific tangent thresholds are defined but
 never enforced (bug #3).

 The Speech Gate is a new Python module that sits between any candidate speech output
  and the actual session.say() call. It applies the hard rules and facilitation
 priorities from the spec, adds runtime silence detection, and fixes bug #3 as a side
  effect.

 ---
 Files to Modify

 ┌──────────────────────┬─────────────────────────────────────────────────────────┐
 │         File         │                         Change                          │
 ├──────────────────────┼─────────────────────────────────────────────────────────┤
 │ agent/speech_gate.py │ Create — gate logic, dataclasses, silence phrase list   │
 ├──────────────────────┼─────────────────────────────────────────────────────────┤
 │ agent/monitor.py     │ Modify — add silence_requested_until field, two new     │
 │                      │ methods                                                 │
 ├──────────────────────┼─────────────────────────────────────────────────────────┤
 │ agent/main.py        │ Modify — wire silence detection, add _guarded_say(),    │
 │                      │ replace 5 session.say() calls                           │
 └──────────────────────┴─────────────────────────────────────────────────────────┘

 ---
 Step 1 — Create agent/speech_gate.py

 1a. Trigger constants and output dataclass

 from __future__ import annotations
 import logging
 import time
 from dataclasses import dataclass

 logger = logging.getLogger("beat-your-meet.gate")

 class Trigger:
     INTRO               = "intro"
     TIME_WARNING        = "time_warning"
     TANGENT             = "tangent_intervention"
     TRANSITION          = "transition"
     WRAP_UP             = "wrap_up"
     DIRECT_QUESTION     = "direct_question"

 @dataclass
 class MeetingContext:
     style: str                  # "gentle" | "moderate" | "aggressive"
     current_topic: str
     current_item_state: str     # ItemState.value
     elapsed_minutes: float
     allocated_minutes: float
     meeting_overtime: float
     recent_transcript: str      # last 60 s
     in_override_grace: bool
     silence_until: float        # unix timestamp; gate checks time.time() <
 silence_until
     tangent_confidence: float = 0.0
     items_remaining: int = 0

 @dataclass
 class GateResult:
     action: str         # "speak" | "silent"
     text_for_tts: str   # "" when silent
     reason: str
     confidence: float   # 0.0–1.0

 1b. Silence phrase detection

 _SILENCE_PHRASES = [
     "please be quiet", "be quiet", "quiet please",
     "stop talking", "stop interrupting", "don't interrupt",
     "we've got this", "we're fine", "let us talk",
     "hold on bot", "hold on beat", "not now",
     "stay quiet", "zip it", "shh",
 ]

 def detect_silence_request(text: str) -> bool:
     lowered = text.strip().lower()
     return any(phrase in lowered for phrase in _SILENCE_PHRASES)

 1c. Redundancy helper

 def _is_redundant(candidate: str, recent_transcript: str, threshold: float = 0.5) ->
  bool:
     """Return True if >threshold fraction of candidate words appear in recent
 transcript."""
     if not recent_transcript or not candidate:
         return False
     candidate_words = set(candidate.lower().split())
     transcript_words = set(recent_transcript.lower().split())
     overlap = len(candidate_words & transcript_words) / len(candidate_words)
     return overlap > threshold

 1d. Gate logic — evaluate()

 Style-specific tangent confidence thresholds (fixes bug #3):
 _TANGENT_THRESHOLD = {"gentle": 0.80, "moderate": 0.70, "aggressive": 0.60}

 Full rule order:

 1. Empty text → silent (confidence 1.0)
 2. Silence window active AND trigger not in {TRANSITION, WRAP_UP} → silent
   - silence_active = ctx.silence_until > 0 and time.time() < ctx.silence_until
 3. Redundancy check → silent if _is_redundant(candidate, ctx.recent_transcript)
 4. Trigger-specific rules:
   - INTRO → always speak
   - WRAP_UP → always speak (even through silence)
   - TRANSITION → speak unless in_override_grace AND meeting_overtime < 5.0; speak
 regardless if meeting_overtime >= 5.0 (prevents frozen agenda)
   - TIME_WARNING → speak if not in_override_grace
   - TANGENT → speak if tangent_confidence >= threshold and not in_override_grace
   - DIRECT_QUESTION → always speak
 5. Catch-all → silent

 Log every evaluation at INFO level:
 [gate] trigger=time_warning action=speak confidence=0.95 reason="time warning at
 80%"

 Output format matches spec JSON: action, text_for_tts (empty if silent), reason,
 confidence.

 ---
 Step 2 — Modify agent/monitor.py

 Add one field to MeetingState dataclass (after last_override_time):
 silence_requested_until: float = 0.0   # unix timestamp; 0 means no active silence
 request

 Add two methods:

 def update_silence_signal(self):
     """Called when a silence phrase is detected in a participant's speech."""
     self.silence_requested_until = time.time() + 120  # 2-minute window; resets on
 repeat

 def build_meeting_context(self, tangent_confidence: float = 0.0) ->
 "MeetingContext":
     """Snapshot current state into a MeetingContext for gate evaluation."""
     from speech_gate import MeetingContext   # deferred import, avoids circular
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

 No changes to existing methods.

 ---
 Step 3 — Modify agent/main.py

 3a. New imports (top of file)

 from speech_gate import evaluate as gate_evaluate, detect_silence_request, Trigger,
 GateResult

 3b. Wire silence detection in on_speech (line 152)

 After meeting_state.add_transcript(speaker, event.transcript), add:
 if detect_silence_request(event.transcript):
     meeting_state.update_silence_signal()
     logger.info("[gate] Silence signal set by %s", speaker)

 3c. Add _guarded_say() helper (place after _refresh_agent_instructions)

 async def _guarded_say(
     session: AgentSession,
     state: MeetingState,
     candidate_text: str,
     trigger: str,
     tangent_confidence: float = 0.0,
 ) -> bool:
     ctx = state.build_meeting_context(tangent_confidence=tangent_confidence)
     result = gate_evaluate(candidate_text, trigger, ctx)
     logger.info(
         "[gate] trigger=%s action=%s confidence=%.2f reason=%s",
         trigger, result.action, result.confidence, result.reason,
     )
     if result.action == "speak":
         await session.say(result.text_for_tts, allow_interruptions=True)
         state.record_intervention()
         return True
     return False

 Note: record_intervention() is now called here — remove the redundant calls at each
 call site.

 3d. Replace 5 session.say() call sites

 Point 1 — Intro (line 170):
 # Remove: await session.say(intro, allow_interruptions=True)
 await _guarded_say(session, meeting_state, intro, Trigger.INTRO)

 Point 2 — Wrap-up (line 275-280):
 # Remove: await session.say("That wraps up...", allow_interruptions=True)
 await _guarded_say(session, state, "That wraps up our agenda. Great meeting,
 everyone!", Trigger.WRAP_UP)

 Point 3 — Time warning (lines 295-300):
 if state.can_intervene():   # keep outer 30s cooldown guard
     try:
         await _guarded_say(session, state, warning, Trigger.TIME_WARNING)
         # Remove: state.record_intervention() — now inside _guarded_say
     except Exception:
         logger.exception("Failed to deliver time warning")

 Point 4 — Transition (lines 314-318):
 if next_item:
     transition = AGENDA_TRANSITION_TEMPLATE.format(...)
     try:
         await _guarded_say(session, state, transition, Trigger.TRANSITION)
         # Remove: state.record_intervention()
     except Exception:
         logger.exception("Failed to deliver agenda transition")

 Point 5 — Tangent (lines 337-344):

 Also remove the hardcoded 0.7 threshold from _check_tangent() (line 394) — the gate
 now owns this.

 if assessment:
     spoken = assessment.get("spoken_response", "")
     confidence = assessment.get("confidence", 0.0)
     if spoken:
         try:
             await _guarded_say(session, state, spoken, Trigger.TANGENT,
 tangent_confidence=confidence)
             # Remove: state.record_intervention()
         except Exception:
             logger.exception("Failed to deliver tangent intervention")

 In _check_tangent(), remove lines 394-395:
 # Remove these two lines:
 if args.get("confidence", 0) < 0.7:
     args["should_speak"] = False
 The gate is now the sole threshold authority. Keep the should_speak field in the
 tool schema for debug event compatibility (future debug mode plan).

 ---
 Bug Fixed as Side Effect

 Bug #3 — TANGENT_TOLERANCE defined but never enforced. The gate's _TANGENT_THRESHOLD
  dict applies style-specific confidence thresholds (gentle=0.80, moderate=0.70,
 aggressive=0.60), replacing the hardcoded 0.7 in _check_tangent().

 ---
 Verification

 1. Start the agent and confirm the intro fires normally (gate log: action=speak
 trigger=intro).
 2. Speak a silence phrase ("not now") and then trigger a tangent — confirm the
 tangent is suppressed (gate log: action=silent reason="silence requested by
 participant").
 3. Wait 2 minutes after a silence request and trigger a tangent — confirm the bot
 speaks again.
 4. Let an item go into overtime — confirm the transition fires even when silence was
  requested less than 2 minutes ago (gate allows TRANSITION through silence when
 meeting_overtime >= 5 min OR no active override grace).
 5. Check wrap-up fires when all items complete.
 6. Verify bug #3 fix: use aggressive style and a tangent with confidence 0.65 — with
  old code it would speak (0.65 > no style threshold), with new gate it stays silent
 (0.65 < 0.60... wait, 0.65 > 0.60 for aggressive). Use confidence 0.55 — confirms
 silent for aggressive, silent for moderate (< 0.70), silent for gentle (< 0.80).