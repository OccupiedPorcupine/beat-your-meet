"""Speech gate for deciding whether the facilitator should speak."""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass

logger = logging.getLogger("beat-your-meet.gate")


class Trigger:
    INTRO = "intro"
    TIME_WARNING = "time_warning"
    TANGENT = "tangent_intervention"
    TRANSITION = "transition"
    WRAP_UP = "wrap_up"
    DIRECT_QUESTION = "direct_question"


@dataclass
class MeetingContext:
    style: str  # "gentle" | "moderate" | "aggressive"
    current_topic: str
    current_item_state: str  # ItemState.value
    elapsed_minutes: float
    allocated_minutes: float
    meeting_overtime: float
    recent_transcript: str  # last 60s
    in_override_grace: bool
    silence_until: float  # unix timestamp
    tangent_confidence: float = 0.0
    items_remaining: int = 0


@dataclass
class GateResult:
    action: str  # "speak" | "silent"
    text_for_tts: str  # empty when silent
    reason: str
    confidence: float  # 0.0-1.0


_SILENCE_PHRASES = [
    "please be quiet",
    "be quiet",
    "quiet please",
    "stop talking",
    "stop interrupting",
    "don't interrupt",
    "we've got this",
    "we're fine",
    "let us talk",
    "hold on bot",
    "hold on beat",
    "not now",
    "stay quiet",
    "zip it",
    "shh",
]

_TANGENT_THRESHOLD = {"gentle": 0.80, "moderate": 0.70, "aggressive": 0.60}
_WORD_RE = re.compile(r"\b[\w']+\b")


def detect_silence_request(text: str) -> bool:
    lowered = text.strip().lower()
    return any(phrase in lowered for phrase in _SILENCE_PHRASES)


def _tokenize_words(text: str) -> set[str]:
    return set(_WORD_RE.findall(text.lower()))


def _is_redundant(
    candidate: str, recent_transcript: str, threshold: float = 0.5
) -> bool:
    """Return True if >threshold fraction of candidate words appear in transcript."""
    if not recent_transcript or not candidate:
        return False

    candidate_words = _tokenize_words(candidate)
    transcript_words = _tokenize_words(recent_transcript)
    if not candidate_words:
        return False

    overlap = len(candidate_words & transcript_words) / len(candidate_words)
    return overlap > threshold


def _emit(
    *,
    trigger: str,
    action: str,
    text_for_tts: str,
    reason: str,
    confidence: float,
) -> GateResult:
    result = GateResult(
        action=action,
        text_for_tts=text_for_tts if action == "speak" else "",
        reason=reason,
        confidence=max(0.0, min(1.0, confidence)),
    )
    logger.info(
        '[gate] trigger=%s action=%s confidence=%.2f reason="%s"',
        trigger,
        result.action,
        result.confidence,
        result.reason,
    )
    return result


def evaluate(candidate_text: str, trigger: str, ctx: MeetingContext) -> GateResult:
    """Evaluate whether a candidate utterance should be spoken."""
    candidate = candidate_text.strip()

    if not candidate:
        return _emit(
            trigger=trigger,
            action="silent",
            text_for_tts="",
            reason="empty candidate text",
            confidence=1.0,
        )

    silence_active = ctx.silence_until > 0 and time.time() < ctx.silence_until
    if silence_active and trigger not in {Trigger.TRANSITION, Trigger.WRAP_UP}:
        return _emit(
            trigger=trigger,
            action="silent",
            text_for_tts="",
            reason="silence requested by participant",
            confidence=0.98,
        )

    if _is_redundant(candidate, ctx.recent_transcript):
        return _emit(
            trigger=trigger,
            action="silent",
            text_for_tts="",
            reason="candidate speech is redundant with recent transcript",
            confidence=0.90,
        )

    if trigger == Trigger.INTRO:
        return _emit(
            trigger=trigger,
            action="speak",
            text_for_tts=candidate,
            reason="intro should always be delivered",
            confidence=1.0,
        )

    if trigger == Trigger.WRAP_UP:
        return _emit(
            trigger=trigger,
            action="speak",
            text_for_tts=candidate,
            reason="wrap-up should always be delivered",
            confidence=1.0,
        )

    if trigger == Trigger.TRANSITION:
        if ctx.meeting_overtime >= 5.0:
            return _emit(
                trigger=trigger,
                action="speak",
                text_for_tts=candidate,
                reason="transition forced due to significant meeting overtime",
                confidence=0.98,
            )
        if ctx.in_override_grace:
            return _emit(
                trigger=trigger,
                action="silent",
                text_for_tts="",
                reason="host override grace active; transition deferred",
                confidence=0.92,
            )
        return _emit(
            trigger=trigger,
            action="speak",
            text_for_tts=candidate,
            reason="transition allowed",
            confidence=0.95,
        )

    if trigger == Trigger.TIME_WARNING:
        if ctx.in_override_grace:
            return _emit(
                trigger=trigger,
                action="silent",
                text_for_tts="",
                reason="host override grace active; suppressing time warning",
                confidence=0.95,
            )
        return _emit(
            trigger=trigger,
            action="speak",
            text_for_tts=candidate,
            reason="time warning at 80%",
            confidence=0.95,
        )

    if trigger == Trigger.TANGENT:
        threshold = _TANGENT_THRESHOLD.get(ctx.style, _TANGENT_THRESHOLD["moderate"])
        if ctx.in_override_grace:
            return _emit(
                trigger=trigger,
                action="silent",
                text_for_tts="",
                reason="host override grace active; suppressing tangent intervention",
                confidence=0.95,
            )
        if ctx.tangent_confidence >= threshold:
            return _emit(
                trigger=trigger,
                action="speak",
                text_for_tts=candidate,
                reason=(
                    f"tangent confidence {ctx.tangent_confidence:.2f} "
                    f">= style threshold {threshold:.2f}"
                ),
                confidence=ctx.tangent_confidence,
            )
        return _emit(
            trigger=trigger,
            action="silent",
            text_for_tts="",
            reason=(
                f"tangent confidence {ctx.tangent_confidence:.2f} "
                f"below style threshold {threshold:.2f}"
            ),
            confidence=1.0 - min(1.0, ctx.tangent_confidence),
        )

    if trigger == Trigger.DIRECT_QUESTION:
        return _emit(
            trigger=trigger,
            action="speak",
            text_for_tts=candidate,
            reason="direct question should always be answered",
            confidence=1.0,
        )

    return _emit(
        trigger=trigger,
        action="silent",
        text_for_tts="",
        reason=f"no rule allows trigger '{trigger}'",
        confidence=0.75,
    )

