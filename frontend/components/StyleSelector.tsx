"use client";

type Style = "gentle" | "moderate" | "chatting";

interface StyleSelectorProps {
  style: Style;
  onSelect: (style: Style) => void;
}

const STYLES: { value: Style; label: string; description: string }[] = [
  {
    value: "chatting",
    label: "Chat",
    description: "No agenda tracking, just answer questions",
  },
  {
    value: "gentle",
    label: "Gentle",
    description: "Warm nudges, high tangent tolerance (60s)",
  },
  {
    value: "moderate",
    label: "Moderate",
    description: "Friendly but firm, balanced (30s)",
  },
];

export default function StyleSelector({ style, onSelect }: StyleSelectorProps) {
  return (
    <div>
      <label className="block text-sm font-medium mb-2">
        Bot personality
      </label>
      <div className="grid grid-cols-3 gap-3">
        {STYLES.map((s) => (
          <button
            key={s.value}
            onClick={() => onSelect(s.value)}
            className={`p-3 rounded-lg border text-left transition-colors ${
              style === s.value
                ? "border-[#ffb06a]/80 bg-[#ff7a18]/60 text-white"
                : "bg-[#2a1508] border-[#ff7a18]/25 text-orange-100/75 hover:border-[#ff7a18]/50"
            }`}
          >
            <div className="font-medium text-sm">{s.label}</div>
            <div className="text-xs text-gray-400 mt-1">{s.description}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
