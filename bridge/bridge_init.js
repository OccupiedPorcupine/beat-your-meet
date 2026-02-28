/**
 * Bridge Init Script — Injected via add_init_script (CDP) BEFORE page load.
 *
 * Runs on EVERY navigation (including redirects, auth pages, iframes),
 * so we guard with a URL check and wrap in try-catch.
 *
 * Only patches RTCPeerConnection and getUserMedia. Stores raw tracks for
 * bridge.js to wire up after joining.
 */
try {
  if (
    window.location.hostname === "meet.google.com" ||
    window.location.hostname.endsWith(".meet.google.com")
  ) {
    // Collect raw audio tracks from Meet's peer connections
    const capturedTracks = [];
    const connectedTrackIds = new Set();

    // ── RTCPeerConnection override ─────────────────────────────────
    const OriginalRTC = window.RTCPeerConnection;

    function PatchedRTCPeerConnection(...args) {
      const pc = new OriginalRTC(...args);

      pc.addEventListener("track", (event) => {
        if (event.track.kind === "audio") {
          const trackId = event.track.id;
          if (connectedTrackIds.has(trackId)) return;
          connectedTrackIds.add(trackId);

          console.log(`[Bridge:init] Captured audio track: ${trackId}`);
          capturedTracks.push(event.track);

          event.track.addEventListener("ended", () => {
            connectedTrackIds.delete(trackId);
            console.log(`[Bridge:init] Audio track ended: ${trackId}`);
          });
        }
      });

      return pc;
    }

    // Copy prototype and all static methods/properties
    PatchedRTCPeerConnection.prototype = OriginalRTC.prototype;
    Object.keys(OriginalRTC).forEach((key) => {
      try {
        PatchedRTCPeerConnection[key] = OriginalRTC[key];
      } catch (e) {
        // Some properties may not be writable
      }
    });
    // Also copy well-known static methods explicitly
    if (OriginalRTC.generateCertificate) {
      PatchedRTCPeerConnection.generateCertificate =
        OriginalRTC.generateCertificate.bind(OriginalRTC);
    }

    window.RTCPeerConnection = PatchedRTCPeerConnection;

    // ── getUserMedia override (inject agent audio as mic) ──────────
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices
      );

      // Lazy AudioContext — only created when Meet actually requests audio
      let agentAudioCtx = null;
      let agentDestination = null;

      function getAgentAudio() {
        if (!agentAudioCtx) {
          agentAudioCtx = new AudioContext({ sampleRate: 48000 });
          agentDestination = agentAudioCtx.createMediaStreamDestination();
          console.log("[Bridge:init] Created agent AudioContext");
        }
        return agentDestination;
      }

      navigator.mediaDevices.getUserMedia = async function (constraints) {
        if (constraints && constraints.audio) {
          console.log(
            "[Bridge:init] Intercepted getUserMedia — returning agent audio stream"
          );
          const dest = getAgentAudio();
          if (constraints.video) {
            const videoStream = await originalGetUserMedia({
              video: constraints.video,
            });
            return new MediaStream([
              ...dest.stream.getAudioTracks(),
              ...videoStream.getVideoTracks(),
            ]);
          }
          return dest.stream;
        }
        return originalGetUserMedia(constraints);
      };

      // ── Expose state for bridge.js ─────────────────────────────────
      window.__BRIDGE_STATE__ = {
        capturedTracks,
        connectedTrackIds,
        getAgentAudio,
      };

      console.log("[Bridge:init] RTC and getUserMedia overrides installed");
    } else {
      console.warn("[Bridge:init] navigator.mediaDevices not available yet");
    }
  }
} catch (e) {
  console.error("[Bridge:init] Init script error (page will still load):", e);
}
