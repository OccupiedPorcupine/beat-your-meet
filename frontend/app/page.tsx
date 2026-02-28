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
  const [style, setStyle] = useState<"gentle" | "moderate" | "aggressive">(
    "moderate"
  );
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const generateAgenda = async () => {
    if (!description.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`${SERVER_URL}/api/agenda`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          duration_minutes: duration,
        }),
      });
      if (!res.ok) throw new Error("Failed to generate agenda");
      const data = await res.json();
      setAgenda(data);
    } catch (err) {
      console.error("Agenda generation failed:", err);
      alert("Failed to generate agenda. Is the server running?");
    } finally {
      setLoading(false);
    }
  };

  const createMeeting = async () => {
    if (!agenda) return;
    setCreating(true);
    try {
      const res = await fetch(`${SERVER_URL}/api/room`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agenda, style }),
      });
      if (!res.ok) throw new Error("Failed to create room");
      const data = await res.json();
      router.push(`/room/${data.room_name}`);
    } catch (err) {
      console.error("Room creation failed:", err);
      alert("Failed to create meeting room. Is the server running?");
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="max-w-2xl mx-auto px-4 py-12">
      <div className="text-center mb-10">
        <h1 className="text-4xl font-bold mb-2">Beat Your Meet</h1>
        <p className="text-gray-400 text-lg">
          AI meeting facilitator that keeps your meetings on track
        </p>
      </div>

      {!agenda ? (
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
