"use client";

import { useEffect, useRef, useState } from "react";

export interface ChatMessage {
  sender: string;
  text: string;
  isAgent: boolean;
  timestamp: number; // unix epoch seconds
}

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
}

export default function ChatPanel({ messages, onSend }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isBeatMention = (text: string) =>
    text.trim().toLowerCase().startsWith("@beat");

  return (
    <div className="flex flex-col h-full" style={{ background: "rgba(5,5,10,0.92)" }}>
      {/* Header */}
      <div className="px-4 py-3 flex items-center justify-between flex-shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
        <span className="text-sm font-semibold" style={{ color: "rgba(220,220,240,0.85)" }}>Chat</span>
        <span className="text-xs" style={{ color: "rgba(180,180,200,0.50)" }}>
          Use <span className="font-mono" style={{ color: "#06d6f7" }}>@beat</span> to ask the AI
        </span>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3 min-h-0">
        {messages.length === 0 && (
          <p className="text-center text-xs mt-6" style={{ color: "rgba(180,180,200,0.38)" }}>
            No messages yet. Say hi or ask{" "}
            <span className="font-mono" style={{ color: "#06d6f7" }}>@beat</span> something.
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className="rounded-xl px-3 py-2 text-sm"
            style={
              msg.isAgent
                ? { background: "rgba(255,122,24,0.08)", border: "1px solid rgba(255,122,24,0.22)" }
                : isBeatMention(msg.text)
                ? { background: "rgba(155,45,202,0.10)", border: "1px solid rgba(155,45,202,0.28)" }
                : { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }
            }
          >
            <div className="flex items-baseline gap-2 mb-0.5">
              <span
                className="text-xs font-semibold"
                style={{ color: msg.isAgent ? "#ff7a18" : "rgba(200,200,220,0.60)" }}
              >
                {msg.sender}
              </span>
              <span className="text-xs" style={{ color: "rgba(160,160,180,0.38)" }}>
                {new Date(msg.timestamp * 1000).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
            <p className="leading-snug break-words" style={{ color: "rgba(230,230,245,0.90)" }}>{msg.text}</p>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-3 py-2 flex gap-2 flex-shrink-0" style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message… (@beat to ask the AI)"
          className="flex-1 rounded-xl px-3 py-2 text-sm text-white focus:outline-none"
          style={{
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.12)",
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = "rgba(255,122,24,0.55)"; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)"; }}
        />
        <button
          onClick={handleSend}
          disabled={!input.trim()}
          className="px-3 py-2 rounded-xl text-sm font-semibold transition-all"
          style={
            input.trim()
              ? { background: "rgba(255,122,24,0.75)", color: "#fff", border: "1px solid rgba(255,122,24,0.5)" }
              : { background: "rgba(255,255,255,0.05)", color: "rgba(180,180,200,0.35)", border: "1px solid rgba(255,255,255,0.08)" }
          }
        >
          Send
        </button>
      </div>
    </div>
  );
}
