"use client";

import React, { useState, useCallback, useRef, useEffect } from "react";
import { useRoomContext } from "@livekit/components-react";
import AgendaDisplay from "./AgendaDisplay";
import type { AgendaState } from "./AgendaDisplay";

interface FloatingAgendaPanelProps {
  isOpen: boolean;
  onClose: () => void;
  agendaState: AgendaState | null;
}

type FacilitatorStyle = "gentle" | "moderate" | "aggressive";
const STYLE_OPTIONS: FacilitatorStyle[] = ["gentle", "moderate", "aggressive"];

function normalizeStyle(style?: string): FacilitatorStyle {
  if (
    style === "gentle" ||
    style === "moderate" ||
    style === "aggressive"
  ) {
    return style;
  }
  return "moderate";
}

export default function FloatingAgendaPanel({
  isOpen,
  onClose,
  agendaState,
}: FloatingAgendaPanelProps) {
  const room = useRoomContext();
  // null until the first client-side paint so the panel never flashes at a
  // wrong position during SSR or hydration.
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null
  );
  const [activeStyle, setActiveStyle] = useState<FacilitatorStyle>(
    normalizeStyle(agendaState?.style)
  );
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const panelRef = useRef<HTMLDivElement>(null);

  // Set the correct initial position after mount (client-only)
  useEffect(() => {
    setPosition({ x: window.innerWidth - 336, y: 16 });
  }, []);

  useEffect(() => {
    if (agendaState?.style) {
      setActiveStyle(normalizeStyle(agendaState.style));
    }
  }, [agendaState?.style]);

  const handleStyleChange = useCallback(
    (newStyle: FacilitatorStyle) => {
      setActiveStyle(newStyle);
      const payload = JSON.stringify({ type: "set_style", style: newStyle });
      room.localParticipant
        .publishData(new TextEncoder().encode(payload), { reliable: true })
        .catch(console.error);
    },
    [room]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!panelRef.current || !position) return;
      setIsDragging(true);
      dragOffset.current = {
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [position]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging || !panelRef.current) return;
      const panelRect = panelRef.current.getBoundingClientRect();
      const newX = Math.max(
        0,
        Math.min(
          window.innerWidth - panelRect.width,
          e.clientX - dragOffset.current.x
        )
      );
      const newY = Math.max(
        0,
        Math.min(
          window.innerHeight - panelRect.height,
          e.clientY - dragOffset.current.y
        )
      );
      setPosition({ x: newX, y: newY });
    },
    [isDragging]
  );

  const handlePointerUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  if (!isOpen || position === null) return null;

  return (
    <div
      ref={panelRef}
      className="floating-agenda-panel"
      style={{
        left: position.x,
        top: position.y,
      }}
    >
      {/* Drag handle / header */}
      <div
        className="drag-handle flex items-center justify-between px-4 py-2 border-b border-gray-700"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <span className="text-sm font-semibold text-gray-300">Agenda</span>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-300 transition-colors p-1"
          title="Close agenda panel"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M1 1l12 12M13 1L1 13"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {/* Agenda content */}
      <div className="px-3 py-2 border-b border-gray-800 flex gap-2">
        {STYLE_OPTIONS.map((style) => (
          <button
            key={style}
            onClick={() => handleStyleChange(style)}
            className={`flex-1 text-xs py-1 rounded transition-colors capitalize ${
              activeStyle === style
                ? "bg-blue-600 text-white"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700"
            }`}
          >
            {style}
          </button>
        ))}
      </div>
      <div className="p-2">
        {agendaState ? (
          <AgendaDisplay state={agendaState} />
        ) : (
          <div className="py-6 text-center text-sm text-gray-500">
            Loading agenda...
          </div>
        )}
      </div>
    </div>
  );
}
