"""Multi-participant audio mixer for LiveKit voice agents.

Subscribes to ALL remote participants' audio tracks in a room,
mixes them into a single mono stream, and yields frames to the
STT pipeline via the AudioInput interface.
"""

from __future__ import annotations

import array
import asyncio
import logging
from livekit import rtc
from livekit.agents.voice.io import AudioInput

logger = logging.getLogger("beat-your-meet")

SAMPLE_RATE = 24000
NUM_CHANNELS = 1
FRAME_DURATION_MS = 50
SAMPLES_PER_FRAME = SAMPLE_RATE * FRAME_DURATION_MS // 1000  # 1200


class MultiParticipantAudioInput(AudioInput):
    """AudioInput that mixes audio from all participants in a LiveKit room."""

    def __init__(
        self,
        room: rtc.Room,
        *,
        sample_rate: int = SAMPLE_RATE,
        num_channels: int = NUM_CHANNELS,
        frame_duration_ms: int = FRAME_DURATION_MS,
    ) -> None:
        super().__init__(label="MultiParticipantMixer")
        self._room = room
        self._sample_rate = sample_rate
        self._num_channels = num_channels
        self._frame_duration_ms = frame_duration_ms
        self._samples_per_frame = sample_rate * frame_duration_ms // 1000

        # Per-participant latest frame buffer (consumed each mixer tick)
        self._participant_frames: dict[str, rtc.AudioFrame | None] = {}
        self._streams: dict[str, rtc.AudioStream] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}

        self._output_queue: asyncio.Queue[rtc.AudioFrame] = asyncio.Queue(maxsize=50)
        self._mixer_task: asyncio.Task[None] | None = None
        self._running = False

    # ------------------------------------------------------------------
    # AudioInput lifecycle
    # ------------------------------------------------------------------

    def on_attached(self) -> None:
        logger.info("MultiParticipantAudioInput attached — starting mixer")
        self._running = True

        self._room.on("track_subscribed", self._on_track_subscribed)
        self._room.on("track_unsubscribed", self._on_track_unsubscribed)
        self._room.on("participant_disconnected", self._on_participant_disconnected)

        # Pick up tracks that were subscribed before we attached
        for participant in self._room.remote_participants.values():
            for pub in participant.track_publications.values():
                if (
                    pub.track is not None
                    and pub.kind == rtc.TrackKind.KIND_AUDIO
                    and pub.source == rtc.TrackSource.SOURCE_MICROPHONE
                ):
                    self._add_participant_stream(pub.track, pub, participant)

        self._mixer_task = asyncio.create_task(self._mixer_loop())

    def on_detached(self) -> None:
        logger.info("MultiParticipantAudioInput detached — stopping mixer")
        self._running = False

        self._room.off("track_subscribed", self._on_track_subscribed)
        self._room.off("track_unsubscribed", self._on_track_unsubscribed)
        self._room.off("participant_disconnected", self._on_participant_disconnected)

        for task in self._tasks.values():
            task.cancel()
        self._tasks.clear()

        for stream in self._streams.values():
            asyncio.create_task(stream.aclose())
        self._streams.clear()
        self._participant_frames.clear()

        if self._mixer_task:
            self._mixer_task.cancel()

    async def __anext__(self) -> rtc.AudioFrame:
        if not self._running:
            raise StopAsyncIteration
        return await self._output_queue.get()

    # ------------------------------------------------------------------
    # Room event handlers
    # ------------------------------------------------------------------

    def _on_track_subscribed(
        self,
        track: rtc.RemoteTrack,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        if publication.kind != rtc.TrackKind.KIND_AUDIO:
            return
        if publication.source != rtc.TrackSource.SOURCE_MICROPHONE:
            return
        self._add_participant_stream(track, publication, participant)

    def _on_track_unsubscribed(
        self,
        track: rtc.RemoteTrack,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        self._remove_participant_stream(participant.identity)

    def _on_participant_disconnected(
        self, participant: rtc.RemoteParticipant
    ) -> None:
        self._remove_participant_stream(participant.identity)

    # ------------------------------------------------------------------
    # Stream management
    # ------------------------------------------------------------------

    def _add_participant_stream(
        self,
        track: rtc.RemoteTrack,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        identity = participant.identity
        if identity in self._streams:
            return  # already tracking

        logger.info("Mixer: adding audio stream for %s", identity)

        stream = rtc.AudioStream.from_track(
            track=track,
            sample_rate=self._sample_rate,
            num_channels=self._num_channels,
            frame_size_ms=self._frame_duration_ms,
        )
        self._streams[identity] = stream
        self._participant_frames[identity] = None
        self._tasks[identity] = asyncio.create_task(
            self._forward_participant(identity, stream)
        )

    def _remove_participant_stream(self, identity: str) -> None:
        if identity not in self._streams:
            return

        logger.info("Mixer: removing audio stream for %s", identity)

        task = self._tasks.pop(identity, None)
        if task:
            task.cancel()

        stream = self._streams.pop(identity, None)
        if stream:
            asyncio.create_task(stream.aclose())

        self._participant_frames.pop(identity, None)

    async def _forward_participant(
        self, identity: str, stream: rtc.AudioStream
    ) -> None:
        """Continuously read frames from one participant's audio stream."""
        try:
            async for event in stream:
                self._participant_frames[identity] = event.frame
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Error reading audio from %s", identity)

    # ------------------------------------------------------------------
    # Mixer
    # ------------------------------------------------------------------

    async def _mixer_loop(self) -> None:
        """Emit one mixed frame per tick at the configured frame rate."""
        interval = self._frame_duration_ms / 1000.0

        try:
            while self._running:
                await asyncio.sleep(interval)
                frame = self._mix_frames()
                try:
                    self._output_queue.put_nowait(frame)
                except asyncio.QueueFull:
                    # Drop oldest to prevent backpressure
                    try:
                        self._output_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    self._output_queue.put_nowait(frame)
        except asyncio.CancelledError:
            pass

    def _mix_frames(self) -> rtc.AudioFrame:
        """Mix all buffered participant frames into one, or return silence."""
        frames: list[rtc.AudioFrame] = []
        for identity in list(self._participant_frames):
            f = self._participant_frames.get(identity)
            if f is not None:
                frames.append(f)
                self._participant_frames[identity] = None

        n = self._samples_per_frame * self._num_channels

        if not frames:
            return self._silence_frame()

        if len(frames) == 1:
            return frames[0]

        # Additive mixing using the array module (int16)
        mixed = array.array("h", bytes(n * 2))  # zeroed

        for frame in frames:
            raw = frame._data
            samples = array.array("h")
            samples.frombytes(raw[: n * 2])
            count = min(len(samples), n)
            for i in range(count):
                mixed[i] += samples[i]

        # Clamp to int16 range
        for i in range(n):
            if mixed[i] > 32767:
                mixed[i] = 32767
            elif mixed[i] < -32768:
                mixed[i] = -32768

        return rtc.AudioFrame(
            data=mixed.tobytes(),
            sample_rate=self._sample_rate,
            num_channels=self._num_channels,
            samples_per_channel=self._samples_per_frame,
        )

    def _silence_frame(self) -> rtc.AudioFrame:
        size = self._samples_per_frame * self._num_channels * 2
        return rtc.AudioFrame(
            data=bytes(size),
            sample_rate=self._sample_rate,
            num_channels=self._num_channels,
            samples_per_channel=self._samples_per_frame,
        )
