/**
 * Google Meet ↔ LiveKit Audio Bridge
 *
 * Injected into the Google Meet page by Playwright. This script:
 * 1. Overrides RTCPeerConnection to capture incoming Meet audio tracks
 * 2. Connects to a LiveKit room and publishes the captured audio
 * 3. Subscribes to agent audio from LiveKit and plays it into Meet
 * 4. Reports bridge status via LiveKit data channel
 *
 * Configuration is passed via window.__BRIDGE_CONFIG__ before injection.
 */

(async () => {
  const config = window.__BRIDGE_CONFIG__;
  if (!config) {
    console.error("[Bridge] No __BRIDGE_CONFIG__ found on window");
    return;
  }

  const { livekitUrl, livekitToken, roomName } = config;

  // ── Status reporting ─────────────────────────────────────────────
  let livekitRoom = null;

  async function sendStatus(status, detail = "") {
    console.log(`[Bridge] Status: ${status} ${detail}`);
    if (livekitRoom && livekitRoom.localParticipant) {
      try {
        const payload = new TextEncoder().encode(
          JSON.stringify({ type: "bridge_status", status, detail })
        );
        await livekitRoom.localParticipant.publishData(payload, {
          reliable: true,
          topic: "bridge_status",
        });
      } catch (e) {
        console.warn("[Bridge] Failed to send status:", e);
      }
    }
  }

  // ── Audio capture setup ──────────────────────────────────────────
  const audioContext = new AudioContext({ sampleRate: 48000 });
  const mixerDestination = audioContext.createMediaStreamDestination();

  // Gain node to control capture volume and muting during TTS
  const captureGain = audioContext.createGain();
  captureGain.connect(mixerDestination);

  // Track connected audio sources to avoid duplicates
  const connectedTracks = new Set();

  // ── RTCPeerConnection override ───────────────────────────────────
  // Must be set up BEFORE Google Meet creates its peer connections
  const OriginalRTCPeerConnection = window.RTCPeerConnection;

  window.RTCPeerConnection = function (...args) {
    const pc = new OriginalRTCPeerConnection(...args);

    pc.addEventListener("track", (event) => {
      if (event.track.kind === "audio") {
        const trackId = event.track.id;
        if (connectedTracks.has(trackId)) return;
        connectedTracks.add(trackId);

        console.log(`[Bridge] Captured audio track: ${trackId}`);

        try {
          const source = audioContext.createMediaStreamSource(
            new MediaStream([event.track])
          );
          source.connect(captureGain);
        } catch (e) {
          console.error("[Bridge] Failed to connect audio source:", e);
        }

        // Clean up when track ends
        event.track.addEventListener("ended", () => {
          connectedTracks.delete(trackId);
          console.log(`[Bridge] Audio track ended: ${trackId}`);
        });
      }
    });

    return pc;
  };

  // Preserve prototype chain
  window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;

  // ── getUserMedia override (for injecting agent audio as mic) ─────
  const agentDestination = audioContext.createMediaStreamDestination();
  const agentGain = audioContext.createGain();
  agentGain.connect(agentDestination);

  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
    navigator.mediaDevices
  );

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    if (constraints && constraints.audio) {
      console.log("[Bridge] Intercepted getUserMedia — returning agent audio stream");
      // Return the agent audio stream as the "microphone"
      // Also include video if requested
      if (constraints.video) {
        const videoStream = await originalGetUserMedia({ video: constraints.video });
        const combinedStream = new MediaStream([
          ...agentDestination.stream.getAudioTracks(),
          ...videoStream.getVideoTracks(),
        ]);
        return combinedStream;
      }
      return agentDestination.stream;
    }
    return originalGetUserMedia(constraints);
  };

  // ── LiveKit SDK (loaded by Playwright's add_script_tag before this runs) ──
  const LivekitClient = window.LivekitClient;
  if (!LivekitClient) {
    console.error("[Bridge] LiveKit SDK not found on window — was it loaded before bridge.js?");
    sendStatus("ERROR", "LiveKit SDK not available");
    return;
  }

  // ── Connect to LiveKit room ──────────────────────────────────────
  sendStatus("CONNECTING", "Connecting to LiveKit room...");

  livekitRoom = new LivekitClient.Room({
    adaptiveStream: false,
    dynacast: false,
  });

  try {
    await livekitRoom.connect(livekitUrl, livekitToken);
    console.log(`[Bridge] Connected to LiveKit room: ${roomName}`);
  } catch (e) {
    console.error("[Bridge] Failed to connect to LiveKit:", e);
    sendStatus("ERROR", `LiveKit connection failed: ${e.message}`);
    return;
  }

  // ── Publish captured Meet audio to LiveKit ───────────────────────
  sendStatus("CONNECTING", "Publishing audio to LiveKit...");

  try {
    // Resume AudioContext (Chrome requires user gesture, but Playwright
    // can bypass this with --autoplay-policy=no-user-gesture-required)
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const capturedTrack = mixerDestination.stream.getAudioTracks()[0];
    if (capturedTrack) {
      await livekitRoom.localParticipant.publishTrack(capturedTrack, {
        name: "meet-capture",
        source: LivekitClient.Track.Source.Microphone,
        dtx: false,
        red: false,
      });
      console.log("[Bridge] Published Meet audio to LiveKit");
    } else {
      console.warn("[Bridge] No audio track available yet — will publish when available");
    }
  } catch (e) {
    console.error("[Bridge] Failed to publish audio:", e);
    sendStatus("ERROR", `Audio publish failed: ${e.message}`);
  }

  // ── Subscribe to agent audio from LiveKit ────────────────────────
  livekitRoom.on(
    LivekitClient.RoomEvent.TrackSubscribed,
    (track, publication, participant) => {
      // Only subscribe to audio tracks from the agent (not our own)
      if (
        track.kind === "audio" &&
        participant.identity !== livekitRoom.localParticipant.identity
      ) {
        console.log(
          `[Bridge] Subscribed to audio from: ${participant.identity}`
        );

        try {
          const mediaStream = new MediaStream([track.mediaStreamTrack]);
          const source = audioContext.createMediaStreamSource(mediaStream);
          source.connect(agentGain);
          console.log("[Bridge] Agent audio routed to Meet microphone");
        } catch (e) {
          console.error("[Bridge] Failed to route agent audio:", e);
        }
      }
    }
  );

  // ── Echo cancellation: mute capture during agent speech ──────────
  // Listen for data channel messages signaling agent speech state
  livekitRoom.on(
    LivekitClient.RoomEvent.DataReceived,
    (payload, participant, kind, topic) => {
      if (topic === "agent_speaking") {
        try {
          const data = JSON.parse(new TextDecoder().decode(payload));
          if (data.speaking) {
            // Mute the capture (don't send agent's own voice back)
            captureGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.1);
          } else {
            // Unmute capture after agent stops speaking
            captureGain.gain.setTargetAtTime(1, audioContext.currentTime, 0.3);
          }
        } catch (e) {
          // ignore
        }
      }
    }
  );

  sendStatus("CONNECTED", "Audio bridge active");

  // ── Health monitoring ────────────────────────────────────────────
  setInterval(() => {
    const stats = {
      capturedTracks: connectedTracks.size,
      audioContextState: audioContext.state,
      livekitState: livekitRoom.state,
    };
    console.log("[Bridge] Health:", JSON.stringify(stats));
  }, 30000);

  // ── Handle disconnection ─────────────────────────────────────────
  livekitRoom.on(LivekitClient.RoomEvent.Disconnected, () => {
    console.log("[Bridge] Disconnected from LiveKit room");
    sendStatus("DISCONNECTED", "LiveKit connection lost");
  });

  console.log("[Bridge] Audio bridge fully initialized");
})();
