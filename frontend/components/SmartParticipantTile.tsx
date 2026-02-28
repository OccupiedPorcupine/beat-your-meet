"use client";

import React from "react";
import {
  useParticipantTile,
  useTrackRefContext,
  VideoTrack,
  ParticipantName,
  ConnectionQualityIndicator,
  TrackMutedIndicator,
  TrackRefContextIfNeeded,
  ParticipantContextIfNeeded,
} from "@livekit/components-react";
import type {
  TrackReferenceOrPlaceholder,
  ParticipantClickEvent,
} from "@livekit/components-react";
import { Track, ParticipantKind } from "livekit-client";

interface SmartParticipantTileProps
  extends React.HTMLAttributes<HTMLDivElement> {
  trackRef?: TrackReferenceOrPlaceholder;
  onParticipantClick?: (event: ParticipantClickEvent) => void;
  disableSpeakingIndicator?: boolean;
}

function getInitials(name: string): string {
  return (name || "?").charAt(0).toUpperCase();
}

function isBot(participant: { kind?: unknown; identity: string }): boolean {
  if (participant.kind === ParticipantKind.AGENT) return true;
  return (
    participant.identity.startsWith("agent-") ||
    participant.identity.toLowerCase().includes("bot")
  );
}

export default function SmartParticipantTile({
  trackRef,
  onParticipantClick,
  disableSpeakingIndicator,
  ...htmlProps
}: SmartParticipantTileProps) {
  const { elementProps } = useParticipantTile({
    trackRef,
    onParticipantClick,
    disableSpeakingIndicator,
    htmlProps,
  });

  const trackReference = useTrackRefContext();
  const participant = trackReference.participant;
  const isBotParticipant = isBot(participant);
  const hasVideo =
    trackReference.publication?.track &&
    !trackReference.publication.isMuted &&
    trackReference.source === Track.Source.Camera;

  if (isBotParticipant) {
    return (
      <div
        {...elementProps}
        className={`lk-participant-tile bot-tile ${elementProps.className || ""}`}
      >
        <TrackRefContextIfNeeded trackRef={trackRef}>
          <ParticipantContextIfNeeded participant={participant}>
            <div className="flex flex-col items-center justify-center w-full h-full gap-3">
              {/* Bot avatar SVG */}
              <svg
                width="64"
                height="64"
                viewBox="0 0 64 64"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="opacity-90"
              >
                <rect
                  x="12"
                  y="20"
                  width="40"
                  height="32"
                  rx="6"
                  fill="#3b82f6"
                  fillOpacity="0.3"
                  stroke="#3b82f6"
                  strokeWidth="2"
                />
                <circle cx="24" cy="36" r="4" fill="#3b82f6" />
                <circle cx="40" cy="36" r="4" fill="#3b82f6" />
                <line
                  x1="32"
                  y1="8"
                  x2="32"
                  y2="20"
                  stroke="#3b82f6"
                  strokeWidth="2"
                />
                <circle cx="32" cy="8" r="3" fill="#3b82f6" />
                <path
                  d="M26 44 C26 46, 28 48, 32 48 C36 48, 38 46, 38 44"
                  stroke="#3b82f6"
                  strokeWidth="2"
                  fill="none"
                />
              </svg>
              <ParticipantName className="text-sm text-gray-300 font-medium" />
            </div>
          </ParticipantContextIfNeeded>
        </TrackRefContextIfNeeded>
      </div>
    );
  }

  // Human participant
  return (
    <div
      {...elementProps}
      className={`lk-participant-tile ${elementProps.className || ""}`}
    >
      <TrackRefContextIfNeeded trackRef={trackRef}>
        <ParticipantContextIfNeeded participant={participant}>
          {hasVideo ? (
            <VideoTrack trackRef={trackReference as any} />
          ) : (
            <div className="human-placeholder">
              {getInitials(participant.name || participant.identity)}
            </div>
          )}
          <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 p-2 bg-gradient-to-t from-black/70 to-transparent">
            <ParticipantName className="text-xs text-white font-medium truncate flex-1" />
            <TrackMutedIndicator
              trackRef={{
                participant,
                source: Track.Source.Microphone,
              } as any}
            />
            <ConnectionQualityIndicator />
          </div>
        </ParticipantContextIfNeeded>
      </TrackRefContextIfNeeded>
    </div>
  );
}
