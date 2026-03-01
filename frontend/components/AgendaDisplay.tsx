"use client";

import { useEffect, useState } from "react";

export interface AgendaItemState {
  id: number;
  topic: string;
  duration_minutes: number;
  state: string;
  actual_elapsed: number;
}

export interface ItemNotes {
  item_id: number;
  topic: string;
  key_points: string[];
  decisions: string[];
  action_items: string[];
}

export interface AgendaState {
  current_item_index: number;
  items: AgendaItemState[];
  elapsed_minutes: number;
  meeting_overtime: number;
  total_meeting_minutes: number;
  style?: string;
  meeting_notes?: ItemNotes[];
}

function ItemNotesPanel({ notes }: { notes: ItemNotes }) {
  return (
    <div className="mt-1 pl-2 text-xs space-y-1" style={{ borderLeft: "1px solid rgba(255,255,255,0.12)" }}>
      {notes.key_points.map((p, i) => (
        <p key={i} style={{ color: "rgba(200,210,240,0.60)" }}>{p}</p>
      ))}
      {notes.decisions.map((d, i) => (
        <p key={i} style={{ color: "#ff7a18" }}>✓ {d}</p>
      ))}
      {notes.action_items.map((a, i) => (
        <p key={i} className="text-amber-400">→ {a}</p>
      ))}
    </div>
  );
}

interface AgendaDisplayProps {
  state: AgendaState;
}

export default function AgendaDisplay({ state }: AgendaDisplayProps) {
  const [now, setNow] = useState(Date.now());
  // Record the local timestamp each time a new state snapshot arrives from the agent
  const [lastStateAt, setLastStateAt] = useState(Date.now());
  const [openNotesById, setOpenNotesById] = useState<Record<number, boolean>>({});

  useEffect(() => {
    setLastStateAt(Date.now());
  }, [state]);

  useEffect(() => {
    if (!state.meeting_notes) return;
    setOpenNotesById((prev) => {
      const next = { ...prev };
      for (const note of state.meeting_notes) {
        if (next[note.item_id] === undefined) next[note.item_id] = true;
      }
      return next;
    });
  }, [state.meeting_notes]);

  // Tick every second so the progress bar and elapsed time count up smoothly
  // between the 15-second agent updates
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Interpolate both timers forward from the last received snapshot so all
  // clocks count up smoothly between the 15-second agent updates.
  const drift = (now - lastStateAt) / 60_000;
  const liveElapsedMinutes = state.elapsed_minutes + drift;
  const liveTotalMinutes = state.total_meeting_minutes + drift;

  const currentItem = state.items[state.current_item_index];

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.09)" }}>
      {/* Header with overall meeting time */}
      <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
        <h2 className="font-semibold text-sm" style={{ color: "rgba(220,220,240,0.90)" }}>Agenda</h2>
        <div className="flex items-center gap-4 text-sm">
          <span style={{ color: "rgba(180,180,200,0.55)" }}>
            Meeting: {formatMinutes(liveTotalMinutes)}
          </span>
          {state.meeting_overtime > 0 && (
            <span className="text-amber-400">
              +{formatMinutes(state.meeting_overtime)} over
            </span>
          )}
        </div>
      </div>

      {/* Agenda items */}
      <div style={{ borderTop: "none" }}>
        {state.items.map((item, index) => {
          const isActive = index === state.current_item_index;
          const isCompleted = item.state === "completed";
          const isOvertime =
            item.state === "overtime" || item.state === "extended";
          const isWarning = item.state === "warning";
          const notes = isCompleted
            ? (state.meeting_notes ?? []).find((n) => n.item_id === item.id)
            : undefined;
          const isNotesOpen = notes ? openNotesById[item.id] !== false : false;

          return (
            <div
              key={item.id}
              className="px-4 py-3 transition-colors"
              style={{
                background: isActive ? "rgba(255,122,24,0.07)" : "transparent",
                opacity: isCompleted ? 0.6 : 1,
                borderBottom: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <div className="flex items-center gap-3">
                {/* Status indicator */}
                <div
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{
                    background: isActive
                      ? isOvertime
                        ? "#ef4444"
                        : isWarning
                        ? "#f59e0b"
                        : "#22c55e"
                      : isCompleted
                      ? "rgba(180,180,200,0.25)"
                      : "rgba(180,180,200,0.18)",
                  }}
                />

                {/* Topic */}
                <span
                  className="flex-1 text-sm"
                  style={
                    isCompleted
                      ? { textDecoration: "line-through", color: "rgba(180,180,200,0.40)" }
                      : { color: "rgba(230,230,245,0.90)" }
                  }
                >
                  {item.topic}
                </span>

                {/* Time */}
                <span
                  className="text-sm font-mono"
                  style={{
                    color: isActive && isOvertime
                      ? "#f87171"
                      : isActive && isWarning
                      ? "#fbbf24"
                      : isActive
                      ? "#ff7a18"
                      : "rgba(160,160,180,0.45)",
                  }}
                >
                  {isActive
                    ? `${formatMinutes(liveElapsedMinutes)} / ${item.duration_minutes}m`
                    : isCompleted
                    ? `${formatMinutes(item.actual_elapsed)}`
                    : `${item.duration_minutes}m`}
                </span>

                {notes && (
                  <button
                    type="button"
                    onClick={() =>
                      setOpenNotesById((prev) => ({
                        ...prev,
                        [item.id]: !(prev[item.id] ?? true),
                      }))
                    }
                    className="text-xs"
                    style={{ color: "rgba(180,180,200,0.60)" }}
                  >
                    {isNotesOpen ? "Hide summary" : "Show summary"}
                  </button>
                )}
              </div>

              {/* Notes for completed items */}
              {notes && isNotesOpen && <ItemNotesPanel notes={notes} />}
            </div>
          );
        })}
      </div>

      {/* Current item progress bar */}
      {currentItem && (
        <div className="px-4 py-2" style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}>
          <div className="w-full rounded-full h-1.5" style={{ background: "rgba(255,255,255,0.08)" }}>
            <div
              className="h-1.5 rounded-full transition-all duration-1000"
              style={{
                background: liveElapsedMinutes > currentItem.duration_minutes
                  ? "#ef4444"
                  : liveElapsedMinutes > currentItem.duration_minutes * 0.8
                  ? "#f59e0b"
                  : "#ff7a18",
                width: `${Math.min(
                  100,
                  (liveElapsedMinutes / currentItem.duration_minutes) * 100
                )}%`,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function formatMinutes(minutes: number): string {
  const m = Math.floor(minutes);
  const s = Math.floor((minutes - m) * 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
