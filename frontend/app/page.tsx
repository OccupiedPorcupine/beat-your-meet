"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import AgendaEditor from "@/components/AgendaEditor";
import StyleSelector from "@/components/StyleSelector";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:8000";

interface AgendaItem {
  id: number;
  topic: string;
  description: string;
  duration_minutes: number;
}

interface Agenda {
  title: string;
  items: AgendaItem[];
  total_minutes: number;
}

export default function Home() {
  const router = useRouter();
  const [mode, setMode] = useState<"create" | "join">("create");

  // Create meeting state
  const [description, setDescription] = useState("");
  const [duration, setDuration] = useState(30);
  const [agenda, setAgenda] = useState<Agenda | null>(null);
  const [style, setStyle] = useState<"gentle" | "moderate" | "aggressive">(
    "moderate"
  );
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdRoom, setCreatedRoom] = useState<{
    roomName: string;
    accessCode: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // Join meeting state
  const [joinRoomName, setJoinRoomName] = useState("");
  const [joinAccessCode, setJoinAccessCode] = useState("");

  const generateAgenda = async () => {
    if (!description.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/agenda`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          duration_minutes: duration,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `Server error ${res.status}`);
      }
      const data = await res.json();
      setAgenda(data);
    } catch (err) {
      console.error("Agenda generation failed:", err);
      setError(err instanceof Error ? err.message : "Failed to generate agenda");
    } finally {
      setLoading(false);
    }
  };

  const createMeeting = async () => {
    if (!agenda) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/room`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agenda, style }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `Server error ${res.status}`);
      }
      const data = await res.json();
      setCreatedRoom({ roomName: data.room_name, accessCode: data.access_code });
    } catch (err) {
      console.error("Room creation failed:", err);
      setError(err instanceof Error ? err.message : "Failed to create meeting room");
    } finally {
      setCreating(false);
    }
  };

  const joinMeeting = () => {
    const room = joinRoomName.trim();
    const code = joinAccessCode.trim().toUpperCase();
    if (!room || !code) return;
    router.push(`/room/${room}?code=${code}`);
  };

  // Share screen after room creation
  if (createdRoom) {
    const shareUrl = `${window.location.origin}/room/${createdRoom.roomName}?code=${createdRoom.accessCode}`;

    const copyLink = async () => {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };

    return (
      <main className="max-w-2xl mx-auto px-4 py-12">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold mb-2">Meeting Created!</h1>
          <p className="text-gray-400 text-lg">
            Share this link with participants to join
          </p>
        </div>

        <div className="space-y-6">
          <div className="p-4 bg-gray-900 border border-gray-700 rounded-lg">
            <label className="block text-sm font-medium text-gray-400 mb-2">
              Shareable Link
            </label>
            <div className="flex gap-2">
              <input
                readOnly
                value={shareUrl}
                className="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white text-sm font-mono truncate"
              />
              <button
                onClick={copyLink}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          <div className="p-4 bg-gray-900 border border-gray-700 rounded-lg text-center">
            <label className="block text-sm font-medium text-gray-400 mb-1">
              Access Code
            </label>
            <span className="text-2xl font-bold font-mono tracking-widest">
              {createdRoom.accessCode}
            </span>
          </div>

          <button
            onClick={() =>
              router.push(
                `/room/${createdRoom.roomName}?code=${createdRoom.accessCode}`
              )
            }
            className="w-full py-3 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors"
          >
            Join Meeting
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-2xl mx-auto px-4 py-12">
      <div className="text-center mb-10">
        <h1 className="text-4xl font-bold mb-2">Beat Your Meet</h1>
        <p className="text-gray-400 text-lg">
          AI meeting facilitator that keeps your meetings on track
        </p>
      </div>

      {/* Mode toggle */}
      <div className="flex mb-8 bg-gray-900 rounded-lg p-1 border border-gray-700">
        <button
          onClick={() => { setMode("create"); setError(null); }}
          className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
            mode === "create"
              ? "bg-blue-600 text-white"
              : "text-gray-400 hover:text-white"
          }`}
        >
          Create Meeting
        </button>
        <button
          onClick={() => { setMode("join"); setError(null); }}
          className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
            mode === "join"
              ? "bg-blue-600 text-white"
              : "text-gray-400 hover:text-white"
          }`}
        >
          Join Meeting
        </button>
      </div>

      {error && (
        <div className="mb-6 p-3 bg-red-900/30 border border-red-800 rounded-lg text-red-400 text-sm">
          <span className="font-medium">Error: </span>{error}
        </div>
      )}

      {mode === "join" ? (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-2">
              Room Name
            </label>
            <input
              type="text"
              value={joinRoomName}
              onChange={(e) => setJoinRoomName(e.target.value)}
              placeholder="e.g. meet-a1b2c3d4"
              className="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-white font-mono placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">
              Access Code
            </label>
            <input
              type="text"
              value={joinAccessCode}
              onChange={(e) => setJoinAccessCode(e.target.value)}
              placeholder="e.g. MEET-7X3K"
              className="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-white font-mono tracking-widest placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <button
            onClick={joinMeeting}
            disabled={!joinRoomName.trim() || !joinAccessCode.trim()}
            className="w-full py-3 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-lg transition-colors"
          >
            Join Meeting
          </button>
        </div>
      ) : !agenda ? (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-2">
              What is this meeting about?
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Weekly standup to discuss progress on the Q1 roadmap, blockers, and hiring updates..."
              className="w-full h-32 px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">
              Meeting duration (minutes)
            </label>
            <div className="flex gap-3">
              {[15, 30, 45, 60].map((d) => (
                <button
                  key={d}
                  onClick={() => setDuration(d)}
                  className={`px-4 py-2 rounded-lg border transition-colors ${
                    duration === d
                      ? "bg-blue-600 border-blue-500 text-white"
                      : "bg-gray-900 border-gray-700 text-gray-300 hover:border-gray-500"
                  }`}
                >
                  {d} min
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={generateAgenda}
            disabled={!description.trim() || loading}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-lg transition-colors"
          >
            {loading ? "Generating agenda..." : "Generate Agenda"}
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">{agenda.title}</h2>
            <button
              onClick={() => setAgenda(null)}
              className="text-sm text-gray-400 hover:text-white"
            >
              Start over
            </button>
          </div>

          <AgendaEditor agenda={agenda} onUpdate={setAgenda} />

          <StyleSelector style={style} onSelect={setStyle} />

          <button
            onClick={createMeeting}
            disabled={creating}
            className="w-full py-3 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-lg transition-colors"
          >
            {creating ? "Creating meeting..." : "Create Meeting"}
          </button>
        </div>
      )}
    </main>
  );
}
