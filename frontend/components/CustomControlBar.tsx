"use client";

import {
  TrackToggle,
  StartAudio,
} from "@livekit/components-react";
import { Track } from "livekit-client";

interface CustomControlBarProps {
  activeSidePanel: "agenda" | "chat" | null;
  onToggleAgenda: () => void;
  onToggleChat: () => void;
  onEndMeeting: () => void | Promise<void>;
  onLeave: () => void | Promise<void>;
  leaving?: boolean;
}

export default function CustomControlBar({
  activeSidePanel,
  onToggleAgenda,
  onToggleChat,
  onEndMeeting,
  onLeave,
  leaving = false,
}: CustomControlBarProps) {
  return (
    <div className="custom-control-bar">
      <TrackToggle source={Track.Source.Microphone} className="lk-button" />
      <TrackToggle source={Track.Source.Camera} className="lk-button" />

      {/* Agenda tab toggle */}
      <button
        onClick={onToggleAgenda}
        className={activeSidePanel === "agenda" ? "lk-button room-ctrl-btn-active" : "lk-button room-ctrl-btn-inactive"}
        title={activeSidePanel === "agenda" ? "Hide Agenda" : "Show Agenda"}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 4h14M3 8h10M3 12h14M3 16h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {/* Chat tab toggle */}
      <button
        onClick={onToggleChat}
        className={activeSidePanel === "chat" ? "lk-button room-ctrl-btn-active" : "lk-button room-ctrl-btn-inactive"}
        title={activeSidePanel === "chat" ? "Hide Chat" : "Show Chat"}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M2 4a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H6l-4 4V4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      </button>

      {/* End Meeting — generates docs then navigates to post-meeting via agent event */}
      <button
        onClick={() => void onEndMeeting()}
        className="lk-button"
        title="End Meeting"
        style={{ color: "rgb(248 113 113)" }}
      >
        End Meeting
      </button>

      {/* Leave — signal end-of-meeting to agent (for doc gen), then navigate */}
      <button
        type="button"
        className="lk-button lk-disconnect-button"
        onClick={() => void onLeave()}
        disabled={leaving}
      >
        {leaving ? "Ending..." : "Leave"}
      </button>

      <StartAudio label="Allow Audio" />
    </div>
  );
}
