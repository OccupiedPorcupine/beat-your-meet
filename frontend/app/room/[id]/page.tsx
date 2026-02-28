"use client";

import { useState, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  GridLayout,
  LayoutContextProvider,
  ConnectionStateToast,
  useDataChannel,
  useTracks,
  PreJoin,
} from "@livekit/components-react";
import type { LocalUserChoices } from "@livekit/components-react";
import "@livekit/components-styles";
import { Track } from "livekit-client";
import SmartParticipantTile from "@/components/SmartParticipantTile";
import CustomControlBar from "@/components/CustomControlBar";
import FloatingAgendaPanel from "@/components/FloatingAgendaPanel";
import type { AgendaState } from "@/components/AgendaDisplay";

const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:8000";
const LIVEKIT_URL = process.env.NEXT_PUBLIC_LIVEKIT_URL;
if (!LIVEKIT_URL) {
  throw new Error(
    "NEXT_PUBLIC_LIVEKIT_URL is not set. Add it to your .env.local file."
  );
}

async function fetchToken(
  roomName: string,
  participantName: string
): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      room_name: roomName,
      participant_name: participantName,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `Server error ${res.status}`);
  }
  const data = await res.json();
  return data.token;
}

export default function RoomPage() {
  const params = useParams();
  const roomName = params.id as string;
  const [token, setToken] = useState<string | null>(null);
  const [preJoinChoices, setPreJoinChoices] =
    useState<LocalUserChoices | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pre-join screen: device preview + name input
  if (!preJoinChoices || !token) {
    return (
      <main
        className="flex items-center justify-center min-h-screen"
        data-lk-theme="default"
      >
        <div className="w-full max-w-lg">
          <div className="text-center mb-6">
            <h1 className="text-3xl font-bold mb-2">Beat Your Meet</h1>
            <p className="text-gray-400">
              Room: <span className="text-white font-mono">{roomName}</span>
            </p>
          </div>
          {error && (
            <div className="mb-4 p-3 bg-red-900/30 border border-red-800 rounded-lg text-red-400 text-sm text-center">
              {error}
            </div>
          )}
          <PreJoin
            defaults={{
              username: "",
              videoEnabled: true,
              audioEnabled: true,
            }}
            joinLabel="Join Meeting"
            onValidate={(values) => !!values.username?.trim()}
            onSubmit={async (values) => {
              try {
                setError(null);
                const t = await fetchToken(roomName, values.username);
                setToken(t);
                setPreJoinChoices(values);
              } catch {
                setError(
                  "Failed to join room. Is the server running?"
                );
              }
            }}
            onError={(err) => {
              console.error("PreJoin error:", err);
              setError(err?.message || "Device access error");
            }}
          />
        </div>
      </main>
    );
  }

  // Connected meeting room
  return (
    <LiveKitRoom
      token={token}
      serverUrl={LIVEKIT_URL}
      connect={true}
      audio={preJoinChoices.audioEnabled}
      video={preJoinChoices.videoEnabled}
      data-lk-theme="default"
    >
      <MeetingRoom />
    </LiveKitRoom>
  );
}

function MeetingRoom() {
  const [agendaState, setAgendaState] = useState<AgendaState | null>(null);
  const [agendaPanelOpen, setAgendaPanelOpen] = useState(true);

  // Listen for agenda state updates from the agent via data channel
  const onDataReceived = useCallback((msg: any) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(msg.payload));
      if (data.type === "agenda_state") {
        setAgendaState(data);
      }
    } catch {
      // ignore non-JSON messages
    }
  }, []);

  useDataChannel("agenda", onDataReceived);

  const tracks = useTracks([
    { source: Track.Source.Camera, withPlaceholder: true },
    { source: Track.Source.ScreenShare, withPlaceholder: false },
  ]);

  return (
    <div className="h-screen flex flex-col">
      {/* Video grid */}
      <div className="flex-1 relative overflow-hidden min-h-0">
        <LayoutContextProvider>
          <GridLayout tracks={tracks} className="h-full">
            <SmartParticipantTile />
          </GridLayout>
        </LayoutContextProvider>

        {/* Floating agenda panel overlay */}
        <FloatingAgendaPanel
          isOpen={agendaPanelOpen}
          onClose={() => setAgendaPanelOpen(false)}
          agendaState={agendaState}
        />
      </div>

      {/* Control bar pinned to bottom */}
      <CustomControlBar
        agendaPanelOpen={agendaPanelOpen}
        onToggleAgendaPanel={() => setAgendaPanelOpen((o) => !o)}
      />

      <RoomAudioRenderer />
      <ConnectionStateToast />
    </div>
  );
}
