"use client";

interface Participant {
  identity: string;
  name?: string;
  isSpeaking?: boolean;
}

interface ParticipantListProps {
  participants: Participant[];
}

export default function ParticipantList({
  participants,
}: ParticipantListProps) {
  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
      <h3 className="text-sm font-medium text-gray-400 mb-3">
        Participants ({participants.length})
      </h3>
      <ul className="space-y-2">
        {participants.map((p) => {
          const isBot =
            p.identity.startsWith("agent-") ||
            p.identity.toLowerCase().includes("bot");
          return (
            <li
              key={p.identity}
              className="flex items-center gap-2 text-sm"
            >
              <div
                className={`w-2 h-2 rounded-full ${
                  p.isSpeaking ? "bg-green-500" : "bg-gray-600"
                }`}
              />
              <span className="text-white">
                {p.name || p.identity}
              </span>
              {isBot && (
                <span className="text-xs bg-blue-600/30 text-blue-400 px-1.5 py-0.5 rounded">
                  Bot
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
