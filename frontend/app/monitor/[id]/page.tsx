"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  LiveKitRoom,
  useDataChannel,
} from "@livekit/components-react";
import "@livekit/components-styles";
import BridgeStatus from "@/components/BridgeStatus";
import AgendaDisplay from "@/components/AgendaDisplay";

const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:8000";
const LIVEKIT_URL =
  process.env.NEXT_PUBLIC_LIVEKIT_URL || "wss://your-project.livekit.cloud";

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
  if (!res.ok) throw new Error("Failed to get token");
  const data = await res.json();
  return data.token;
}

export default function MonitorPage() {
  const params = useParams();
  const router = useRouter();
  const roomName = params.id as string;
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<{
    status: string;
    meet_url?: string;
  }>({ status: "STARTING" });

  // Get a token so we can connect to the LiveKit room (data channels only)
  useEffect(() => {
    fetchToken(roomName, `monitor-${Date.now()}`)
      .then(setToken)
      .catch((err) => setError(err.message));
  }, [roomName]);

  // Poll bridge status from server
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${SERVER_URL}/api/bridge-status/${roomName}`);
        if (res.ok) {
          const data = await res.json();
          setBridgeStatus(data);
        }
      } catch {
        // ignore polling errors
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [roomName]);

  const handleStop = async () => {
    try {
      await fetch(`${SERVER_URL}/api/bridge-stop/${roomName}`, {
        method: "POST",
      });
      router.push("/");
    } catch (err) {
      console.error("Failed to stop bridge:", err);
    }
  };

  if (error) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-12 text-center">
        <h1 className="text-3xl font-bold mb-4">Beat Your Meet</h1>
        <div className="p-4 bg-red-900/30 border border-red-800 rounded-lg text-red-400">
          {error}
        </div>
      </main>
    );
  }

  if (!token) {
    return (
      <main className="max-w-2xl mx-auto px-4 py-12 text-center">
        <h1 className="text-3xl font-bold mb-4">Beat Your Meet</h1>
        <p className="text-gray-400">Connecting to monitoring dashboard...</p>
      </main>
    );
  }

  return (
    <LiveKitRoom
      token={token}
      serverUrl={LIVEKIT_URL}
      connect={true}
      audio={false}
      video={false}
      data-lk-theme="default"
    >
      <MonitorDashboard
        roomName={roomName}
        bridgeStatus={bridgeStatus}
        onStop={handleStop}
      />
    </LiveKitRoom>
  );
}

function MonitorDashboard({
  roomName,
  bridgeStatus,
  onStop,
}: {
  roomName: string;
  bridgeStatus: { status: string; meet_url?: string };
  onStop: () => void;
}) {
  const [agendaState, setAgendaState] = useState<any>(null);
  const [liveBridgeStatus, setLiveBridgeStatus] = useState<{
    status: string;
    detail?: string;
  } | null>(null);

  // Listen for agenda state updates from the agent
  const onAgendaData = useCallback((msg: any) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(msg.payload));
      if (data.type === "agenda_state") {
        setAgendaState(data);
      }
    } catch {
      // ignore
    }
  }, []);

  // Listen for bridge status updates via data channel
  const onBridgeData = useCallback((msg: any) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(msg.payload));
      if (data.type === "bridge_status") {
        setLiveBridgeStatus({ status: data.status, detail: data.detail });
      }
    } catch {
      // ignore
    }
  }, []);

  useDataChannel("agenda", onAgendaData);
  useDataChannel("bridge_status", onBridgeData);

  // Use live bridge status from data channel if available, otherwise fall back to polling
  const displayStatus = liveBridgeStatus || bridgeStatus;

  return (
    <main className="max-w-2xl mx-auto px-4 py-12">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold mb-2">Beat Your Meet</h1>
        <p className="text-gray-400">
          Monitoring Google Meet session
        </p>
        <p className="text-xs text-gray-600 font-mono mt-1">{roomName}</p>
      </div>

      <div className="space-y-6">
        {/* Bridge status */}
        <BridgeStatus
          status={displayStatus.status}
          detail={"detail" in displayStatus ? displayStatus.detail : undefined}
        />

        {/* Meet URL */}
        {bridgeStatus.meet_url && (
          <div className="p-3 bg-gray-800 rounded-lg border border-gray-700">
            <p className="text-sm text-gray-400">
              Google Meet:{" "}
              <a
                href={bridgeStatus.meet_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 font-mono text-xs"
              >
                {bridgeStatus.meet_url}
              </a>
            </p>
          </div>
        )}

        {/* Agenda progress */}
        {agendaState ? (
          <div>
            <h2 className="text-lg font-semibold mb-3">Agenda Progress</h2>
            <AgendaDisplay state={agendaState} />
          </div>
        ) : (
          <div className="p-4 bg-gray-800 rounded-lg border border-gray-700 text-center">
            <p className="text-gray-500 text-sm">
              Waiting for agent to start facilitating...
            </p>
          </div>
        )}

        {/* Stop button */}
        <button
          onClick={onStop}
          className="w-full py-3 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors"
        >
          Stop Bridge
        </button>
      </div>
    </main>
  );
}
