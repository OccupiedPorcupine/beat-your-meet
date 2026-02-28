"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useParticipants,
  useRoomContext,
  useDataChannel,
} from "@livekit/components-react";
import "@livekit/components-styles";
import AgendaDisplay from "@/components/AgendaDisplay";
import ParticipantList from "@/components/ParticipantList";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:8000";
const LIVEKIT_URL =
  process.env.NEXT_PUBLIC_LIVEKIT_URL || "wss://your-project.livekit.cloud";

export default function RoomPage() {
  const params = useParams();
  const roomName = params.id as string;
  const [token, setToken] = useState<string | null>(null);
  const [userName, setUserName] = useState("");
  const [joined, setJoined] = useState(false);

  const joinRoom = async () => {
    if (!userName.trim()) return;
    try {
      const res = await fetch(`${SERVER_URL}/api/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room_name: roomName,
          participant_name: userName.trim(),
        }),
      });
      if (!res.ok) throw new Error("Failed to get token");
      const data = await res.json();
      setToken(data.token);
      setJoined(true);
    } catch (err) {
      console.error("Failed to join:", err);
      alert("Failed to join room. Is the server running?");
    }
  };

  if (!joined || !token) {
    return (
      <main className="max-w-md mx-auto px-4 py-20">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold mb-2">Beat Your Meet</h1>
          <p className="text-gray-400">
            Room: <span className="text-white font-mono">{roomName}</span>
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">
              Your name
            </label>
            <input
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && joinRoom()}
              placeholder="Enter your display name"
              className="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              autoFocus
            />
          </div>

          <button
            onClick={joinRoom}
            disabled={!userName.trim()}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-lg transition-colors"
          >
            Join Meeting
          </button>
        </div>
      </main>
    );
  }

  return (
    <LiveKitRoom
      token={token}
      serverUrl={LIVEKIT_URL}
      connect={true}
      audio={true}
      video={false}
      className="min-h-screen"
    >
      <MeetingRoom roomName={roomName} />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

function MeetingRoom({ roomName }: { roomName: string }) {
  const room = useRoomContext();
  const participants = useParticipants();
  const [isMuted, setIsMuted] = useState(false);
  const [agendaState, setAgendaState] = useState<any>(null);

  // Listen for agenda state updates from the agent via data channel
  const onDataReceived = useCallback(
    (msg: any) => {
      try {
        const data = JSON.parse(new TextDecoder().decode(msg.payload));
        if (data.type === "agenda_state") {
          setAgendaState(data);
        }
      } catch {
        // ignore non-JSON messages
      }
    },
    []
  );

  useDataChannel("agenda", onDataReceived);

  const toggleMute = async () => {
    const enabled = room.localParticipant.isMicrophoneEnabled;
    await room.localParticipant.setMicrophoneEnabled(!enabled);
    setIsMuted(enabled);
  };

  const leaveRoom = () => {
    room.disconnect();
    window.location.href = "/";
  };

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Beat Your Meet</h1>
          <p className="text-gray-400 text-sm font-mono">{roomName}</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={toggleMute}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              isMuted
                ? "bg-red-600 hover:bg-red-700 text-white"
                : "bg-gray-800 hover:bg-gray-700 text-white"
            }`}
          >
            {isMuted ? "Unmute" : "Mute"}
          </button>
          <button
            onClick={leaveRoom}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
          >
            Leave
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2">
          {agendaState ? (
            <AgendaDisplay state={agendaState} />
          ) : (
            <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
              <p className="text-gray-400 text-center">
                Waiting for meeting to start...
              </p>
            </div>
          )}
        </div>
        <div>
          <ParticipantList participants={participants} />
        </div>
      </div>
    </main>
  );
}
