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
    <div className="mt-1 pl-2 border-l border-gray-700 text-xs space-y-1">
      {notes.key_points.map((p, i) => (
        <p key={i} className="text-gray-400">{p}</p>
      ))}
      {notes.decisions.map((d, i) => (
        <p key={i} className="text-blue-400">✓ {d}</p>
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

  useEffect(() => {
    setLastStateAt(Date.now());
  }, [state]);

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
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
      {/* Header with overall meeting time */}
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <h2 className="font-semibold">Agenda</h2>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-gray-400">
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
      <div className="divide-y divide-gray-800">
        {state.items.map((item, index) => {
          const isActive = index === state.current_item_index;
          const isCompleted = item.state === "completed";
          const isOvertime =
            item.state === "overtime" || item.state === "extended";
          const isWarning = item.state === "warning";
          const notes = isCompleted
            ? (state.meeting_notes ?? []).find((n) => n.item_id === item.id)
            : undefined;

          return (
            <div
              key={item.id}
              className={`px-4 py-3 transition-colors ${
                isActive
                  ? "bg-blue-600/10"
                  : isCompleted
                  ? "opacity-60"
                  : ""
              }`}
            >
              <div className="flex items-center gap-3">
                {/* Status indicator */}
                <div
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    isActive
                      ? isOvertime
                        ? "bg-red-500"
                        : isWarning
                        ? "bg-amber-500"
                        : "bg-green-500"
                      : isCompleted
                      ? "bg-gray-600"
                      : "bg-gray-700"
                  }`}
                />

                {/* Topic */}
                <span
                  className={`flex-1 ${
                    isCompleted ? "line-through text-gray-500" : "text-white"
                  }`}
                >
                  {item.topic}
                </span>

                {/* Time */}
                <span
                  className={`text-sm font-mono ${
                    isActive && isOvertime
                      ? "text-red-400"
                      : isActive && isWarning
                      ? "text-amber-400"
                      : isActive
                      ? "text-blue-400"
                      : "text-gray-500"
                  }`}
                >
                  {isActive
                    ? `${formatMinutes(liveElapsedMinutes)} / ${item.duration_minutes}m`
                    : isCompleted
                    ? `${formatMinutes(item.actual_elapsed)}`
                    : `${item.duration_minutes}m`}
                </span>
              </div>

              {/* Notes for completed items */}
              {notes && <ItemNotesPanel notes={notes} />}
            </div>
          );
        })}
      </div>

      {/* Current item progress bar */}
      {currentItem && (
        <div className="px-4 py-2 border-t border-gray-800">
          <div className="w-full bg-gray-800 rounded-full h-1.5">
            <div
              className={`h-1.5 rounded-full transition-all duration-1000 ${
                liveElapsedMinutes > currentItem.duration_minutes
                  ? "bg-red-500"
                  : liveElapsedMinutes >
                    currentItem.duration_minutes * 0.8
                  ? "bg-amber-500"
                  : "bg-blue-500"
              }`}
              style={{
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
