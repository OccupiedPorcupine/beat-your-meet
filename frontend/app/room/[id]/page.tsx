"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  GridLayout,
  LayoutContextProvider,
  ConnectionStateToast,
  useDataChannel,
  useRoomContext,
  useParticipants,
  useTracks,
  PreJoin,
} from "@livekit/components-react";
import type { LocalUserChoices } from "@livekit/components-react";
import "@livekit/components-styles";
import { Track } from "livekit-client";
import SmartParticipantTile, { isBot } from "@/components/SmartParticipantTile";
import CustomControlBar from "@/components/CustomControlBar";
import AgendaDisplay from "@/components/AgendaDisplay";
import ChatPanel from "@/components/ChatPanel";
import type { AgendaState } from "@/components/AgendaDisplay";
import type { ChatMessage } from "@/components/ChatPanel";

type BeatStyle = "chatting" | "gentle" | "moderate";
type BotStatus = "absent" | "joining" | "active" | "leaving";
const STYLE_OPTIONS: { value: BeatStyle; label: string }[] = [
  { value: "chatting", label: "Chat" },
  { value: "gentle",   label: "Gentle" },
  { value: "moderate", label: "Moderate" },
];
function normalizeStyle(s?: string): BeatStyle {
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
  const router = useRouter();
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
        className="room-join-shell flex items-center justify-center min-h-screen"
        data-lk-theme="default"
      >
        <div className="room-top-actions">
          <button
            type="button"
            onClick={() => router.push("/")}
            className="room-home-btn"
          >
            Home
          </button>
        </div>
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
      <main className="room-prejoin-wrap" data-lk-theme="default">
        <div className="hero-noise" aria-hidden="true" />
        <div className="hero-flares" aria-hidden="true" />
        <div className="room-prejoin-card setup-shell">
          <div className="setup-header">
            <p className="hero-kicker">— BEATYOURMEET</p>
            <div className="flex items-start justify-between gap-4">
              <h2>Join Meeting</h2>
              <button
                type="button"
                onClick={() => router.push("/")}
                className="room-home-btn"
              >
                Home
              </button>
            </div>
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
      <MeetingRoom roomName={roomName} accessCode={accessCode} />
    </LiveKitRoom>
  );
}

function MeetingRoom({ roomName, accessCode }: { roomName: string; accessCode: string }) {
  const router = useRouter();
  const room = useRoomContext();
  const senderName = room.localParticipant.identity;
  const redirectingRef = useRef(false);

  const [agendaState, setAgendaState] = useState<AgendaState | null>(null);
  const [activeSidePanel, setActiveSidePanel] = useState<"agenda" | "chat" | null>("agenda");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [activeStyle, setActiveStyle] = useState<BeatStyle>("moderate");
  const [leaving, setLeaving] = useState(false);
  const [botStatus, setBotStatus] = useState<BotStatus>("absent");
  const [botError, setBotError] = useState<string | null>(null);

  // Host token is stored in sessionStorage during room creation
  const [hostToken] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return sessionStorage.getItem(`host_token_${roomName}`);
  });
  const isHost = !!hostToken;

  const goToPostMeeting = useCallback(() => {
    if (redirectingRef.current) return;
    redirectingRef.current = true;
    const encoded = encodeURIComponent(accessCode);
    router.push(`/post-meeting/${roomName}?code=${encoded}`);
  }, [accessCode, roomName, router]);

  // Track bot presence via participants list
  const participants = useParticipants();
  useEffect(() => {
    const botPresent = participants.some((p) => isBot(p));
    if (botPresent && (botStatus === "joining" || botStatus === "absent")) {
      setBotStatus("active");
    } else if (!botPresent && botStatus === "active") {
      setBotStatus("absent");
    }
  }, [participants, botStatus]);

  // Keep style button in sync with agent-reported style
  useEffect(() => {
    if (agendaState?.style) setActiveStyle(normalizeStyle(agendaState.style));
  }, [agendaState?.style]);

  // Agenda + control messages from the agent
  const onAgendaData = useCallback((msg: any) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(msg.payload));
      if (data.type === "agenda_state") setAgendaState(data);
      else if (data.type === "meeting_ended" || data.type === "docs_ready") {
        goToPostMeeting();
      }
    } catch { /* ignore */ }
  }, [goToPostMeeting]);

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

  const inviteBotToRoom = useCallback(async () => {
    if (!hostToken) return;
    setBotStatus("joining");
    setBotError(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/room/${roomName}/invite-bot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host_token: hostToken }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `Error ${res.status}`);
      }
    } catch (err) {
      setBotStatus("absent");
      setBotError(err instanceof Error ? err.message : "Failed to invite bot");
    }
  }, [hostToken, roomName]);

  const removeBotFromRoom = useCallback(async () => {
    if (!hostToken) return;
    setBotStatus("leaving");
    setBotError(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/room/${roomName}/bot`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host_token: hostToken }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `Error ${res.status}`);
      }
    } catch (err) {
      setBotStatus("active");
      setBotError(err instanceof Error ? err.message : "Failed to remove bot");
    }
  }, [hostToken, roomName]);

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

  const handleStyleChange = useCallback((style: BeatStyle) => {
    setActiveStyle(style);
    const payload = new TextEncoder().encode(JSON.stringify({ type: "set_style", style }));
    room.localParticipant.publishData(payload, { reliable: true }).catch(console.error);
  }, [room]);

  const handleEndMeeting = useCallback(async () => {
    if (!isHost || !hostToken) return;
    const payload = new TextEncoder().encode(
      JSON.stringify({ type: "end_meeting", host_token: hostToken })
    );
    try {
      await room.localParticipant.publishData(payload, { reliable: true });
    } catch (err) {
      console.error("Failed to send end_meeting:", err);
    }
  }, [hostToken, isHost, room]);

  const handleLeave = useCallback(async () => {
    if (leaving) return;
    setLeaving(true);
    room.disconnect();
    router.push("/");
  }, [leaving, room, router]);

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
                {isHost && (
                  <div className="px-3 py-2 flex-shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                    {botStatus === "absent" && (
                      <button
                        onClick={inviteBotToRoom}
                        className="w-full py-1.5 text-xs font-medium rounded-lg bg-emerald-500/25 border border-emerald-400/30 text-emerald-200 hover:bg-emerald-500/40 transition-colors"
                      >
                        Invite Beat
                      </button>
                    )}
                    {botStatus === "joining" && (
                      <div className="w-full py-1.5 text-xs font-medium rounded-lg bg-yellow-500/15 border border-yellow-400/20 text-yellow-200 text-center">
                        Joining...
                      </div>
                    )}
                    {botStatus === "active" && (
                      <button
                        onClick={removeBotFromRoom}
                        className="w-full py-1.5 text-xs font-medium rounded-lg bg-red-500/15 border border-red-400/20 text-red-300 hover:bg-red-500/30 transition-colors"
                      >
                        Remove Beat
                      </button>
                    )}
                    {botStatus === "leaving" && (
                      <div className="w-full py-1.5 text-xs font-medium rounded-lg bg-yellow-500/15 border border-yellow-400/20 text-yellow-200 text-center">
                        Leaving...
                      </div>
                    )}
                    {botError && (
                      <p className="mt-1 text-[10px] text-red-400 text-center">{botError}</p>
                    )}
                  </div>
                )}
                {/* Agenda content */}
                <div className="flex-1 overflow-y-auto p-2">
                  {agendaState ? (
                    <AgendaDisplay state={agendaState} />
                  ) : (
                    <p className="text-center text-sm py-6" style={{ color: "rgba(200,210,240,0.45)" }}>
                      {botStatus === "absent" && isHost
                        ? "Invite Beat to get started"
                        : "Waiting for agent..."}
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
        onEndMeeting={handleEndMeeting}
        onLeave={handleLeave}
        canEndMeeting={isHost}
        leaving={leaving}
      />

      <RoomAudioRenderer />
      <ConnectionStateToast />
    </div>
  );
}
