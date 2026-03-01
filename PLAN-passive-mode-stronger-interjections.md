# Plan: Beat Name Identity + Passive Listening Mode + Stronger Interjections

## Goal

1. **Name**: Ensure Beat knows its name is "Beat" consistently everywhere.
2. **Passive listening state**: Beat stays silent by default and only speaks when (a) a participant addresses it directly by name, or (b) the monitoring loop decides it must interject to keep the meeting on track.
3. **Stronger interjections**: When Beat does speak proactively, it should be more assertive and direct — not wishy-washy suggestions.

---

## Current Architecture (relevant parts)

- `BeatFacilitatorAgent.llm_node` — overrides the voice pipeline's LLM call. Currently handles time queries, skip/end-meeting commands, then falls through to the LLM. It fires on **every** utterance that passes VAD+STT.
- `_monitoring_loop` — runs every 15s, calls `session.say()` for tangent/time/transition events. This is already proactive and bypasses `llm_node`.
- `_guarded_say` — gate function that decides if a monitoring-loop utterance should be spoken.
- `speech_gate.evaluate()` — final gating logic per trigger type.
- `FACILITATOR_SYSTEM_PROMPT` — currently mentions direct address as `"hey bot"` or `"bot,"` — needs updating to `"Beat"`.

---

## Changes Required

### 1. `agent/main.py` — Name detection + passive gating in `llm_node`

**Add** a name-detection function with regex patterns:

```python
_BEAT_NAME_PATTERNS = (
    re.compile(r"\b(?:hey\s+)?beat\b"),      # "beat", "hey beat"
    re.compile(r"\bbeat[,!?]\b"),             # "beat,"  "beat!"
    re.compile(r"^beat\b"),                   # starts with "beat"
    re.compile(r"\b@beat\b"),                 # "@beat"
)

def _is_addressed_to_beat(text: str) -> bool:
    normalized = " ".join(text.lower().split())
    return any(p.search(normalized) for p in _BEAT_NAME_PATTERNS)
```

**Modify** `BeatFacilitatorAgent.llm_node`:

Current flow:
1. Check time query → deterministic answer
2. Check skip request → handle
3. Check end meeting → handle
4. Fall through to LLM

New flow:
1. Check if addressed to Beat by name **OR** falls into a critical command pattern (skip/end)
2. If **not** addressed to Beat → `return` early with no yield (silent)
3. If addressed → run existing logic (time query, skip, end, LLM)

This means:
- Casual conversation between participants → Beat stays silent
- "Beat, what time is it?" → Beat answers
- "Beat, can we skip this?" → Beat skips
- Monitoring loop fires `session.say()` → Beat speaks (bypasses `llm_node` entirely, unaffected)

**Note on skip/end commands**: These will require the name prefix in passive mode. This is intentional — participants must address Beat explicitly to control it. The monitoring loop still auto-advances on timeout.

**Add** `Trigger.NAMED_ADDRESS` in `speech_gate.py` for when the monitoring loop detects it was called by name (future-proofing, not strictly required for MVP).

---

### 2. `agent/prompts.py` — Stronger language + fix name references

#### `FACILITATOR_SYSTEM_PROMPT` — Fix direct address trigger

Change:
```
3. DIRECT ADDRESS: A participant asks you a question directly (says "hey bot" or "bot,").
```
To:
```
3. DIRECT ADDRESS: A participant calls you by name ("Beat", "Hey Beat", "Beat,").
```

Add a note about passive mode:
```
## Passive Listening Mode
You are in passive listening mode. You do NOT speak unless:
- A participant directly addresses you by name ("Beat")
- You are intervening to keep the meeting on track (tangent/time/transition)
Do NOT respond to general conversation between participants.
```

#### `STYLE_INSTRUCTIONS` — Stronger, more authoritative language

Replace gentle/moderate with more assertive variants. Add `aggressive`:

```python
STYLE_INSTRUCTIONS = {
    "gentle": """Be direct but kind. Examples:
- "Hey Beat here — we've drifted from {topic}. Let's pull it back."
- "Quick note: {remaining} minutes left on {topic}. Let's wrap this up."
Don't be vague. Be clear about what needs to happen.""",

    "moderate": """Be firm and clear. Cut through the conversation. Examples:
- "Beat stepping in — this is off-agenda. Back to {topic}, now."
- "Time's up on {topic}. Moving on."
No softening language. State what needs to happen.""",

    "aggressive": """Be blunt and commanding. Examples:
- "Stop. Off topic. Back to {topic}."
- "Time's gone. Next item: {next_item}. Go."
Short, sharp, no pleasantries.""",
}
```

#### `MONITORING_PROMPT` — Request stronger spoken_response

Add to the prompt:
```
When the conversation is off-topic, the spoken_response MUST be assertive and direct.
Do NOT use suggestions or hedging. State clearly: what's wrong, what should happen.
Examples of GOOD responses:
- "Beat here — we're off track. Back to {current_topic}."
- "That's outside our agenda. Let's refocus on {current_topic}."
Examples of BAD responses (too weak):
- "Maybe we could get back to the topic?"
- "Just a gentle reminder..."
```

#### `TIME_WARNING_TEMPLATE` — More direct

Change:
```python
TIME_WARNING_TEMPLATE = (
    "Quick heads up — we've got about {remaining} minutes left on {topic}."
)
```
To:
```python
TIME_WARNING_TEMPLATE = (
    "Beat here — {remaining} minutes left on {topic}. Let's stay focused and wrap this up."
)
```

#### `AGENDA_TRANSITION_TEMPLATE` — More direct

Change:
```python
AGENDA_TRANSITION_TEMPLATE = (
    "Alright, let's move on to the next topic: {next_item}. "
    "We have {duration} minutes for this one."
)
```
To:
```python
AGENDA_TRANSITION_TEMPLATE = (
    "Time's up. Moving to {next_item} — {duration} minutes. Let's go."
)
```

#### `BOT_INTRO_TEMPLATE` — Introduce passive mode behavior

Change intro to let participants know Beat only speaks when called:
```python
BOT_INTRO_TEMPLATE = (
    "Hi, I'm Beat — your meeting facilitator. "
    "I'll stay quiet unless you call my name or the meeting goes off track. "
    "Today: {num_items} items, {total_minutes} minutes. Starting with {first_item}."
)
```

---

### 3. `agent/speech_gate.py` — Add `NAMED_ADDRESS` trigger

Add to `Trigger` class:
```python
NAMED_ADDRESS = "named_address"
```

Handle in `evaluate()` (always speak, same as `DIRECT_QUESTION`):
```python
if trigger == Trigger.NAMED_ADDRESS:
    return _emit(
        trigger=trigger,
        action="speak",
        text_for_tts=candidate,
        reason="participant addressed Beat by name",
        confidence=1.0,
    )
```

---

## What Does NOT Change

- The monitoring loop cadence (every 15s)
- Tangent confidence thresholds (0.7 moderate, 0.8 gentle)
- Intervention cooldown (30s)
- Silence phrase detection (`detect_silence_request`)
- Skip / end-meeting / time-query handling — all still work, just require name address now
- Frontend / server — no changes needed
- Chatting mode — no changes (already has its own passive logic)

---

## Behaviour Summary After Changes

| Situation | Before | After |
|-----------|--------|-------|
| Participants chatting on-topic | Beat might respond | Beat silent |
| Participant says "Beat, what time is it?" | Beat answers | Beat answers |
| Participant says "Skip this" | Beat skips | Beat silent (no name) |
| Participant says "Beat, skip this" | Beat skips | Beat skips |
| 15s monitoring detects tangent (confidence > threshold) | Beat interjects (mild) | Beat interjects (assertive) |
| Time warning at 80% | Beat warns (mild) | Beat warns (firm) |
| Item overtime → auto-advance | Beat transitions (mild) | Beat transitions (firm) |

---

## Files Modified

| File | Change |
|------|--------|
| `agent/main.py` | Add `_BEAT_NAME_PATTERNS`, `_is_addressed_to_beat()`, gate `llm_node` |
| `agent/prompts.py` | Update system prompt, style instructions, templates, intro |
| `agent/speech_gate.py` | Add `Trigger.NAMED_ADDRESS`, handle in `evaluate()` |

No schema changes, no new dependencies, no frontend changes.
