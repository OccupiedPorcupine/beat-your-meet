"use client";

import { useState, useCallback, Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
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
  participantName: string,
  accessCode: string
): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      room_name: roomName,
      participant_name: participantName,
      access_code: accessCode,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (res.status === 403) throw new Error("INVALID_CODE");
    if (res.status === 404) throw new Error("ROOM_NOT_FOUND");
    throw new Error(body?.detail ?? `Server error ${res.status}`);
  }
  const data = await res.json();
  return data.token;
}

export default function RoomPage() {
  return (
    <Suspense
      fallback={
        <main className="flex items-center justify-center min-h-screen">
          <p className="text-gray-400">Loading...</p>
        </main>
      }
    >
      <RoomPageInner />
    </Suspense>
  );
}

function RoomPageInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const roomName = params.id as string;
  const codeFromUrl = searchParams.get("code");

  const [accessCode, setAccessCode] = useState<string | null>(codeFromUrl);
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [preJoinChoices, setPreJoinChoices] =
    useState<LocalUserChoices | null>(null);
  const [error, setError] = useState<string | null>(null);

  // PIN entry screen: shown when no access code in URL
  if (!accessCode) {
    return (
      <main
        className="flex items-center justify-center min-h-screen"
        data-lk-theme="default"
      >
        <div className="w-full max-w-sm">
          <div className="text-center mb-6">
            <h1 className="text-3xl font-bold mb-2">Beat Your Meet</h1>
            <p className="text-gray-400">
              Enter the access code to join this meeting
            </p>
          </div>
          {codeError && (
            <div className="mb-4 p-3 bg-red-900/30 border border-red-800 rounded-lg text-red-400 text-sm text-center">
              {codeError}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = codeInput.trim().toUpperCase();
              if (!trimmed) return;
              setCodeError(null);
              setAccessCode(trimmed);
            }}
            className="space-y-4"
          >
            <input
              type="text"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              placeholder="e.g. MEET-7X3K"
              className="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-white text-center text-lg font-mono tracking-widest placeholder-gray-500 focus:outline-none focus:border-blue-500"
              autoFocus
            />
            <button
              type="submit"
              disabled={!codeInput.trim()}
              className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-lg transition-colors"
            >
              Enter
            </button>
          </form>
        </div>
      </main>
    );
  }

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
                const t = await fetchToken(
                  roomName,
                  values.username,
                  accessCode
                );
                setToken(t);
                setPreJoinChoices(values);
              } catch (err) {
                const msg =
                  err instanceof Error ? err.message : "Unknown error";
                if (msg === "INVALID_CODE") {
                  // Return to PIN screen with error
                  setAccessCode(null);
                  setCodeError("Incorrect code — please try again");
                } else if (msg === "ROOM_NOT_FOUND") {
                  setError(
                    "This meeting has ended or doesn't exist."
                  );
                } else {
                  setError(
                    "Failed to join room. Is the server running?"
                  );
                }
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
