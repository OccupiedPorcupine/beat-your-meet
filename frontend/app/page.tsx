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
  const [description, setDescription] = useState("");
  const [duration, setDuration] = useState(30);
  const [agenda, setAgenda] = useState<Agenda | null>(null);
  const [style, setStyle] = useState<"gentle" | "moderate" | "chatting">(
    "moderate"
  );
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      router.push(`/room/${data.room_name}`);
    } catch (err) {
      console.error("Room creation failed:", err);
      setError(err instanceof Error ? err.message : "Failed to create meeting room");
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="landing-shell">
      <section className="hero-wrap">
        <div className="hero-noise" aria-hidden="true" />
        <div className="hero-flares" aria-hidden="true" />

        <div className="hero-copy">
          <p className="hero-kicker">- BEATYOURMEET AI</p>
          <h1 className="hero-title">BEATYOURMEET AI</h1>
          <p className="hero-subtitle">
            THE AUTONOMOUS MULTI-AGENT MEETING ORCHESTRATION
          </p>
          <p className="hero-meta">
            Live meeting facilitation
            <br />
            Agenda guardrails, tangent recovery, and action capture
          </p>
        </div>

        <div className="hero-centerpiece" aria-hidden="true">
          <div className="primitive-orbit">
            <div className="primitive-glow" />
            <div className="geo-stage">
              <div className="geo-primitive">
                <span className="geo-face face-front" />
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

          {error && (
            <div className="mb-6 rounded-xl border border-red-300/25 bg-red-500/10 p-3 text-sm text-red-100">
              <span className="font-semibold">Error: </span>
              {error}
            </div>
          )}

          {!agenda ? (
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
