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
  const [style, setStyle] = useState<"gentle" | "moderate" | "chatting">(
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
    <main className="landing-shell">
      <section className="hero-wrap">
        <div className="hero-noise" aria-hidden="true" />
        <div className="hero-flares" aria-hidden="true" />

        <div className="hero-copy">
          <p className="hero-kicker">- BEATYOURMEET AI</p>
          <h1 className="hero-title">BEATYOURMEET AI</h1>
          <p className="hero-subtitle">
            THE AI MEETING FACILITATOR THAT KEEPS YOU ON TRACK
          </p>
          <p className="hero-meta">
            Voice-first meeting facilitation
            <br />
            Agenda guardrails, tangent recovery, and time-box awareness
          </p>
        </div>

        <div className="hero-centerpiece" aria-hidden="true">
          <div className="primitive-orbit">
            <div className="primitive-glow" />
            <div className="geo-stage">
              <div className="geo-primitive">
                <span className="geo-face face-front"><span className="mac-face">=)</span></span>
                <span className="geo-face face-back" />
                <span className="geo-face face-left" />
                <span className="geo-face face-right" />
                <span className="geo-face face-top" />
                <span className="geo-face face-bottom" />
              </div>
              <div className="geo-specular" />
            </div>
          </div>
        </div>

        <a href="#setup" className="hero-cta">
          Start a Meeting
        </a>
      </section>

      <section id="setup" className="setup-wrap">
        <div className="setup-shell">
          <div className="setup-header">
            <h2>Set Up Your Meeting</h2>
            <p>Generate your agenda, tune facilitation strictness, and launch the room.</p>
          </div>

          <div className="mb-6 flex rounded-xl border border-white/15 bg-white/10 p-1">
            <button
              onClick={() => {
                setMode("create");
                setError(null);
              }}
              className={`flex-1 rounded-lg py-2 text-sm font-semibold transition ${
                mode === "create"
                  ? "bg-white/25 text-white"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              Create Meeting
            </button>
            <button
              onClick={() => {
                setMode("join");
                setError(null);
              }}
              className={`flex-1 rounded-lg py-2 text-sm font-semibold transition ${
                mode === "join"
                  ? "bg-white/25 text-white"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              Join Meeting
            </button>
          </div>

          {error && (
            <div className="mb-6 rounded-xl border border-red-300/25 bg-red-500/10 p-3 text-sm text-red-100">
              <span className="font-semibold">Error: </span>
              {error}
            </div>
          )}

          {mode === "join" ? (
            <div className="space-y-6">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-100">
                  Room Name
                </label>
                <input
                  type="text"
                  value={joinRoomName}
                  onChange={(e) => setJoinRoomName(e.target.value)}
                  placeholder="e.g. meet-a1b2c3d4"
                  className="w-full rounded-xl border border-white/15 bg-white/10 px-4 py-3 font-mono text-white placeholder:text-slate-300/70 focus:border-slate-200/60 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-100">
                  Access Code
                </label>
                <input
                  type="text"
                  value={joinAccessCode}
                  onChange={(e) => setJoinAccessCode(e.target.value)}
                  placeholder="e.g. MEET-7X3K"
                  className="w-full rounded-xl border border-white/15 bg-white/10 px-4 py-3 font-mono tracking-widest text-white placeholder:text-slate-300/70 focus:border-slate-200/60 focus:outline-none"
                />
              </div>

              <button
                onClick={joinMeeting}
                disabled={!joinRoomName.trim() || !joinAccessCode.trim()}
                className="w-full rounded-xl border border-emerald-200/30 bg-emerald-500/35 py-3 font-semibold text-white transition hover:bg-emerald-500/50 disabled:border-white/10 disabled:bg-white/10 disabled:text-slate-400"
              >
                Join Meeting
              </button>
            </div>
          ) : !agenda ? (
            <div className="space-y-6">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-100">
                  What is this meeting about?
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Weekly standup to discuss progress on the Q1 roadmap, blockers, and hiring updates..."
                  className="h-32 w-full resize-none rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-white placeholder:text-slate-300/70 focus:border-slate-200/60 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-100">
                  Meeting duration (minutes)
                </label>
                <div className="flex flex-wrap gap-3">
                  {[15, 30, 45, 60].map((d) => (
                    <button
                      key={d}
                      onClick={() => setDuration(d)}
                      className={`rounded-xl border px-4 py-2 transition ${
                        duration === d
                          ? "border-white/45 bg-white/25 text-white"
                          : "border-white/15 bg-white/10 text-slate-200 hover:border-white/35"
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
                className="w-full rounded-xl border border-white/35 bg-white/20 py-3 font-semibold text-white transition hover:bg-white/30 disabled:border-white/10 disabled:bg-white/10 disabled:text-slate-400"
              >
                {loading ? "Generating agenda..." : "Generate Agenda"}
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-semibold text-white">{agenda.title}</h3>
                <button
                  onClick={() => setAgenda(null)}
                  className="text-sm text-slate-300 hover:text-white"
                >
                  Start over
                </button>
              </div>

              <AgendaEditor agenda={agenda} onUpdate={setAgenda} />

              <StyleSelector style={style} onSelect={setStyle} />

              <button
                onClick={createMeeting}
                disabled={creating}
                className="w-full rounded-xl border border-emerald-200/30 bg-emerald-500/35 py-3 font-semibold text-white transition hover:bg-emerald-500/50 disabled:border-white/10 disabled:bg-white/10 disabled:text-slate-400"
              >
                {creating ? "Creating meeting..." : "Create Meeting"}
              </button>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
