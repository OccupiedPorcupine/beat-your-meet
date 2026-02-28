"use client";

interface BridgeStatusProps {
  status: string;
  detail?: string;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; pulse: boolean }> = {
  STARTING: { label: "Starting bridge...", color: "text-yellow-400", pulse: true },
  AUTHENTICATING: { label: "Authenticating...", color: "text-yellow-400", pulse: true },
  CONNECTING: { label: "Connecting...", color: "text-yellow-400", pulse: true },
  JOINING_MEET: { label: "Joining Google Meet...", color: "text-yellow-400", pulse: true },
  WAITING_ADMISSION: { label: "Waiting for host to admit...", color: "text-orange-400", pulse: true },
  CONNECTED: { label: "Connected", color: "text-green-400", pulse: false },
  ERROR: { label: "Error", color: "text-red-400", pulse: false },
  DISCONNECTED: { label: "Disconnected", color: "text-gray-400", pulse: false },
  UNKNOWN: { label: "Unknown", color: "text-gray-400", pulse: false },
};

export default function BridgeStatus({ status, detail }: BridgeStatusProps) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.UNKNOWN;

  return (
    <div className="flex items-center gap-3 p-4 bg-gray-800 rounded-lg border border-gray-700">
      <div className="relative">
        <div
          className={`w-3 h-3 rounded-full ${
            status === "CONNECTED"
              ? "bg-green-400"
              : status === "ERROR"
              ? "bg-red-400"
              : status === "DISCONNECTED"
              ? "bg-gray-400"
              : "bg-yellow-400"
          }`}
        />
        {config.pulse && (
          <div
            className={`absolute inset-0 w-3 h-3 rounded-full animate-ping ${
              status === "WAITING_ADMISSION" ? "bg-orange-400" : "bg-yellow-400"
            } opacity-75`}
          />
        )}
      </div>
      <div>
        <p className={`text-sm font-medium ${config.color}`}>{config.label}</p>
        {detail && <p className="text-xs text-gray-500 mt-0.5">{detail}</p>}
      </div>
    </div>
  );
}
