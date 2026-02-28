"use client";

import {
  TrackToggle,
  DisconnectButton,
  StartAudio,
} from "@livekit/components-react";
import { Track } from "livekit-client";

interface CustomControlBarProps {
  agendaPanelOpen: boolean;
  onToggleAgendaPanel: () => void;
}

export default function CustomControlBar({
  agendaPanelOpen,
  onToggleAgendaPanel,
}: CustomControlBarProps) {
  return (
    <div className="custom-control-bar">
      <TrackToggle source={Track.Source.Microphone} className="lk-button" />
      <TrackToggle source={Track.Source.Camera} className="lk-button" />

      {/* Agenda panel toggle */}
      <button
        onClick={onToggleAgendaPanel}
        className={`lk-button px-3 py-2 rounded-md text-sm font-medium transition-colors ${
          agendaPanelOpen
            ? "bg-blue-600 text-white"
            : "bg-gray-800 text-gray-300 hover:bg-gray-700"
        }`}
        title={agendaPanelOpen ? "Hide Agenda" : "Show Agenda"}
      >
        {/* Agenda/list icon */}
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M3 4h14M3 8h10M3 12h14M3 16h8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>

      <DisconnectButton
        className="lk-button lk-disconnect-button"
        onClick={() => {
          window.location.href = "/";
        }}
      >
        Leave
      </DisconnectButton>

      <StartAudio label="Allow Audio" />
    </div>
  );
}
