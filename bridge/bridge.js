/**
 * Google Meet ↔ LiveKit Audio Bridge (Post-Join)
 *
 * Injected AFTER the meeting is joined and the LiveKit SDK is loaded.
 * Relies on window.__BRIDGE_STATE__ (set by bridge_init.js via add_init_script)
 * for the raw captured audio tracks and agent audio destination.
 *
 * This script:
 * 1. Creates an AudioContext and wires up all captured Meet audio tracks
 * 2. Connects to a LiveKit room and publishes the mixed audio
 * 3. Subscribes to agent audio from LiveKit and routes it into Meet's mic
 * 4. Reports bridge status via LiveKit data channel
 */
(async () => {
  const config = window.__BRIDGE_CONFIG__;
  if (!config) {
    console.error("[Bridge] No __BRIDGE_CONFIG__ found on window");
    return;
  }

  const state = window.__BRIDGE_STATE__;
  if (!state) {
    console.error(
      "[Bridge] No __BRIDGE_STATE__ found — bridge_init.js did not run"
    );
    return;
  }

  const { livekitUrl, livekitToken, roomName } = config;
  const { capturedTracks, connectedTrackIds, getAgentAudio } = state;

  // ── Audio graph setup ──────────────────────────────────────────
  const audioContext = new AudioContext({ sampleRate: 48000 });
  const mixerDestination = audioContext.createMediaStreamDestination();

  // Gain node to control capture volume (muted during agent TTS)
  const captureGain = audioContext.createGain();
  captureGain.connect(mixerDestination);

  // Wire up tracks already captured by bridge_init.js
  console.log(
    `[Bridge] Wiring up ${capturedTracks.length} previously captured tracks`
  );
  for (const track of capturedTracks) {
    try {
      const source = audioContext.createMediaStreamSource(
        new MediaStream([track])
      );
      source.connect(captureGain);
      console.log(`[Bridge] Wired existing track: ${track.id}`);
    } catch (e) {
      console.error(`[Bridge] Failed to wire track ${track.id}:`, e);
    }
  }

  // Also hook future tracks (in case new participants join after bridge starts)
  const originalPush = capturedTracks.push.bind(capturedTracks);
  capturedTracks.push = function (...tracks) {
    for (const track of tracks) {
      try {
        const source = audioContext.createMediaStreamSource(
          new MediaStream([track])
        );
        source.connect(captureGain);
        console.log(`[Bridge] Wired new track: ${track.id}`);
      } catch (e) {
        console.error(`[Bridge] Failed to wire new track ${track.id}:`, e);
      }
    }
    return originalPush(...tracks);
  };

  // Get the agent audio destination (created lazily by bridge_init.js).
  // Lives in its own AudioContext — agent tracks connect directly to it.
  const agentDest = getAgentAudio();

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

  // ── LiveKit SDK ────────────────────────────────────────────────
  const LivekitClient = window.LivekitClient;
  if (!LivekitClient) {
    console.error(
      "[Bridge] LiveKit SDK not found — was it loaded before bridge.js?"
    );
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

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  async function publishCapturedAudio() {
    const capturedTrack = mixerDestination.stream.getAudioTracks()[0];
    if (!capturedTrack) {
      return false;
    }
    try {
      await livekitRoom.localParticipant.publishTrack(capturedTrack, {
        name: "meet-capture",
        source: LivekitClient.Track.Source.Microphone,
        dtx: false,
        red: false,
      });
      console.log("[Bridge] Published Meet audio to LiveKit");
      return true;
    } catch (e) {
      console.error("[Bridge] Failed to publish audio:", e);
      sendStatus("ERROR", `Audio publish failed: ${e.message}`);
      return false;
    }
  }

  // Try to publish immediately; if no tracks yet, retry with backoff
  if (!(await publishCapturedAudio())) {
    console.log("[Bridge] No audio tracks yet — retrying with backoff...");
    let published = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      console.log(
        `[Bridge] Publish retry ${attempt + 1}/15 (captured tracks: ${connectedTrackIds.size})`
      );
      if (await publishCapturedAudio()) {
        published = true;
        break;
      }
    }
    if (!published) {
      console.error("[Bridge] Failed to publish audio after all retries");
      sendStatus("ERROR", "No audio tracks captured from Meet");
    }
  }

  // ── Subscribe to agent audio from LiveKit ────────────────────────
  livekitRoom.on(
    LivekitClient.RoomEvent.TrackSubscribed,
    (track, publication, participant) => {
      if (
        track.kind === "audio" &&
        participant.identity !== livekitRoom.localParticipant.identity
      ) {
        console.log(
          `[Bridge] Subscribed to audio from: ${participant.identity}`
        );

        try {
          // Route agent audio into the agent AudioContext's destination
          // so it flows through the getUserMedia override into Meet
          const agentCtx = agentDest.context;
          const mediaStream = new MediaStream([track.mediaStreamTrack]);
          const source = agentCtx.createMediaStreamSource(mediaStream);
          source.connect(agentDest);
          console.log("[Bridge] Agent audio routed to Meet microphone");
        } catch (e) {
          console.error("[Bridge] Failed to route agent audio:", e);
        }
      }
    }
  );

  // ── Echo cancellation: mute capture during agent speech ──────────
  livekitRoom.on(
    LivekitClient.RoomEvent.DataReceived,
    (payload, participant, kind, topic) => {
      if (topic === "agent_speaking") {
        try {
          const data = JSON.parse(new TextDecoder().decode(payload));
          if (data.speaking) {
            captureGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.1);
          } else {
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
      capturedTracks: connectedTrackIds.size,
      audioContextState: audioContext.state,
      agentAudioContextState: agentDest.context.state,
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
