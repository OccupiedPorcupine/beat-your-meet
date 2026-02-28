"use client";

import React, { useState, useCallback, useRef, useEffect } from "react";
import AgendaDisplay from "./AgendaDisplay";
import type { AgendaState } from "./AgendaDisplay";

interface FloatingAgendaPanelProps {
  isOpen: boolean;
  onClose: () => void;
  agendaState: AgendaState | null;
}

export default function FloatingAgendaPanel({
  isOpen,
  onClose,
  agendaState,
}: FloatingAgendaPanelProps) {
  // null until the first client-side paint so the panel never flashes at a
  // wrong position during SSR or hydration.
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null
  );
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const panelRef = useRef<HTMLDivElement>(null);

  // Set the correct initial position after mount (client-only)
  useEffect(() => {
    setPosition({ x: window.innerWidth - 336, y: 16 });
  }, []);

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
