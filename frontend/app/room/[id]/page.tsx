"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  GridLayout,
  LayoutContextProvider,
  ConnectionStateToast,
  useDataChannel,
  useRoomContext,
  useTracks,
  PreJoin,
} from "@livekit/components-react";
import type { LocalUserChoices } from "@livekit/components-react";
import "@livekit/components-styles";
import { Track } from "livekit-client";
import SmartParticipantTile from "@/components/SmartParticipantTile";
import CustomControlBar from "@/components/CustomControlBar";
import AgendaDisplay from "@/components/AgendaDisplay";
import ChatPanel from "@/components/ChatPanel";
import type { AgendaState } from "@/components/AgendaDisplay";
import type { ChatMessage } from "@/components/ChatPanel";

type FacilitatorStyle = "chatting" | "gentle" | "moderate";
const STYLE_OPTIONS: { value: FacilitatorStyle; label: string }[] = [
  { value: "chatting", label: "Chat" },
  { value: "gentle",   label: "Gentle" },
  { value: "moderate", label: "Moderate" },
];
function normalizeStyle(s?: string): FacilitatorStyle {
  if (s === "chatting" || s === "gentle" || s === "moderate") return s;
  return "moderate";
}

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
      <main className="room-prejoin-wrap" data-lk-theme="default">
        <div className="hero-noise" aria-hidden="true" />
        <div className="hero-flares" aria-hidden="true" />
        <div className="room-prejoin-card setup-shell">
          <div className="setup-header">
            <p className="hero-kicker">— BEATYOURMEET AI</p>
            <h2>Join Meeting</h2>
            <p>
              Room:{" "}
              <span className="font-mono" style={{ color: "rgba(255,200,100,0.85)" }}>
                {roomName}
              </span>
            </p>
          </div>
          {error && (
            <div className="mb-4 rounded-xl border border-red-300/25 bg-red-500/10 p-3 text-sm text-red-100 text-center">
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
  const router = useRouter();
  const room = useRoomContext();
  const senderName = room.localParticipant.identity;

  const [agendaState, setAgendaState] = useState<AgendaState | null>(null);
  const [activeSidePanel, setActiveSidePanel] = useState<"agenda" | "chat" | null>("agenda");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [activeStyle, setActiveStyle] = useState<FacilitatorStyle>("moderate");

  // Keep style button in sync with agent-reported style
  useEffect(() => {
    if (agendaState?.style) setActiveStyle(normalizeStyle(agendaState.style));
  }, [agendaState?.style]);

  // Agenda + control messages from the agent
  const onAgendaData = useCallback((msg: any) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(msg.payload));
      if (data.type === "agenda_state") setAgendaState(data);
      else if (data.type === "meeting_ended") router.push("/");
    } catch { /* ignore */ }
  }, [router]);

  // Inbound chat messages (from all participants + Beat)
  const onChatData = useCallback((msg: any) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(msg.payload));
      if (data.type === "chat_message") {
        setChatMessages((prev) => [
          ...prev,
          {
            sender: data.sender,
            text: data.text,
            isAgent: data.is_agent ?? false,
            timestamp: data.timestamp ?? Date.now() / 1000,
          },
        ]);
      }
    } catch { /* ignore */ }
  }, []);

  useDataChannel("agenda", onAgendaData);
  useDataChannel("chat", onChatData);

  const sendChatMessage = useCallback((text: string) => {
    setChatMessages((prev) => [
      ...prev,
      { sender: senderName, text, isAgent: false, timestamp: Date.now() / 1000 },
    ]);
    const payload = new TextEncoder().encode(
      JSON.stringify({ type: "chat_message", sender: senderName, text, is_agent: false, timestamp: Date.now() / 1000 })
    );
    room.localParticipant.publishData(payload, { reliable: true, topic: "chat" }).catch(console.error);
  }, [room, senderName]);

  const handleStyleChange = useCallback((style: FacilitatorStyle) => {
    setActiveStyle(style);
    const payload = new TextEncoder().encode(JSON.stringify({ type: "set_style", style }));
    room.localParticipant.publishData(payload, { reliable: true }).catch(console.error);
  }, [room]);

  const togglePanel = useCallback((panel: "agenda" | "chat") => {
    setActiveSidePanel((prev) => (prev === panel ? null : panel));
  }, []);

  const tracks = useTracks([
    { source: Track.Source.Camera, withPlaceholder: true },
    { source: Track.Source.ScreenShare, withPlaceholder: false },
  ]);

  return (
    <div className="room-shell">
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Video grid */}
        <div className="flex-1 relative overflow-hidden min-h-0">
          <LayoutContextProvider>
            <GridLayout tracks={tracks} className="h-full">
              <SmartParticipantTile />
            </GridLayout>
          </LayoutContextProvider>
        </div>

        {/* Tabbed side panel */}
        {activeSidePanel !== null && (
          <div className="room-side-panel">
            {/* Tab headers */}
            <div className="room-tab-header">
              <button
                onClick={() => setActiveSidePanel("agenda")}
                className={activeSidePanel === "agenda" ? "room-tab-btn-active" : "room-tab-btn-inactive"}
              >
                Agenda
              </button>
              <button
                onClick={() => setActiveSidePanel("chat")}
                className={activeSidePanel === "chat" ? "room-tab-btn-active" : "room-tab-btn-inactive"}
              >
                Chat
              </button>
            </div>

            {/* Agenda tab */}
            {activeSidePanel === "agenda" && (
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* Style selector */}
                <div className="px-3 py-2 flex gap-2 flex-shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                  {STYLE_OPTIONS.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => handleStyleChange(s.value)}
                      className={activeStyle === s.value ? "room-style-btn-active" : "room-style-btn-inactive"}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                {/* Agenda content */}
                <div className="flex-1 overflow-y-auto p-2">
                  {agendaState ? (
                    <AgendaDisplay state={agendaState} />
                  ) : (
                    <p className="text-center text-sm py-6" style={{ color: "rgba(200,210,240,0.45)" }}>
                      Waiting for agent…
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Chat tab */}
            {activeSidePanel === "chat" && (
              <ChatPanel messages={chatMessages} onSend={sendChatMessage} />
            )}
          </div>
        )}
      </div>

      {/* Control bar */}
      <CustomControlBar
        activeSidePanel={activeSidePanel}
        onToggleAgenda={() => togglePanel("agenda")}
        onToggleChat={() => togglePanel("chat")}
      />

      <RoomAudioRenderer />
      <ConnectionStateToast />
    </div>
  );
}
