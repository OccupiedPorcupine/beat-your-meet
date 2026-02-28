"use client";

import { useEffect, useState } from "react";

interface AgendaItemState {
  id: number;
  topic: string;
  duration_minutes: number;
  state: string;
  actual_elapsed: number;
}

interface AgendaState {
  current_item_index: number;
  items: AgendaItemState[];
  elapsed_minutes: number;
  meeting_overtime: number;
  total_meeting_minutes: number;
}

interface AgendaDisplayProps {
  state: AgendaState;
}

export default function AgendaDisplay({ state }: AgendaDisplayProps) {
  const [now, setNow] = useState(Date.now());

  // Tick every second for live timer
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const currentItem = state.items[state.current_item_index];

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
      {/* Header with overall meeting time */}
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <h2 className="font-semibold">Agenda</h2>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-gray-400">
            Meeting: {formatMinutes(state.total_meeting_minutes)}
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

          return (
            <div
              key={item.id}
              className={`px-4 py-3 flex items-center gap-3 transition-colors ${
                isActive
                  ? "bg-blue-600/10"
                  : isCompleted
                  ? "opacity-50"
                  : ""
              }`}
            >
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
                  ? `${formatMinutes(state.elapsed_minutes)} / ${item.duration_minutes}m`
                  : isCompleted
                  ? `${formatMinutes(item.actual_elapsed)}`
                  : `${item.duration_minutes}m`}
              </span>
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
                state.elapsed_minutes > currentItem.duration_minutes
                  ? "bg-red-500"
                  : state.elapsed_minutes >
                    currentItem.duration_minutes * 0.8
                  ? "bg-amber-500"
                  : "bg-blue-500"
              }`}
              style={{
                width: `${Math.min(
                  100,
                  (state.elapsed_minutes / currentItem.duration_minutes) * 100
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
