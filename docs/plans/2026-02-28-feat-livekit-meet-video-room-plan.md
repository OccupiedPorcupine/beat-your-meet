---
title: "feat: LiveKit Meet-Style Video Meeting Room"
type: feat
date: 2026-02-28
brainstorm: docs/brainstorms/2026-02-28-livekit-meet-room-ui-brainstorm.md
---

# feat: LiveKit Meet-Style Video Meeting Room

## Overview

Replace the current audio-only meeting room UI with a full video conferencing room inspired by LiveKit Meet. Users will see a responsive video grid with participant tiles, a pre-join device preview screen, the AI facilitator bot as an avatar tile in the grid, and the agenda tracker as a floating overlay panel.

## Problem Statement / Motivation

The current meeting room at [room/[id]/page.tsx](frontend/app/room/[id]/page.tsx) is audio-only with a basic 2-column layout (agenda + text participant list). This feels like a prototype, not a product. A video-enabled room with proper controls and a polished layout would make Beat Your Meet feel like a real meeting tool and let users see each other — which matters for engagement and social pressure to stay on-topic.

## Proposed Solution

Build a custom video conference layout using `@livekit/components-react` building blocks (`GridLayout`, `useTracks`, `TrackToggle`, `DisconnectButton`), with a custom participant tile renderer that shows an avatar for the AI bot. Wrap the existing `AgendaDisplay` in a floating overlay panel toggled from the control bar.

**Why not use `VideoConference` composite directly?** It doesn't accept custom tile renderers, and we need a custom bot avatar tile. Building with building blocks gives us that control while still leveraging LiveKit's grid layout, track management, and media controls.

## Technical Approach

### Architecture

```
/room/[id] page
├── Pre-join screen (PreJoin component, outside LiveKitRoom)
│   ├── Camera preview + device selector
│   ├── Mic preview + device selector
│   ├── Name input
│   └── "Join Meeting" button
│
└── Meeting room (inside LiveKitRoom)
    ├── Custom video grid (GridLayout + SmartParticipantTile)
    │   ├── Human tiles: VideoTrack or initials placeholder
    │   └── Bot tile: Custom avatar with speaking animation
    ├── Floating agenda panel (toggleable, draggable overlay)
    │   └── AgendaDisplay (existing component, unchanged)
    ├── Custom control bar
    │   ├── TrackToggle (microphone)
    │   ├── TrackToggle (camera)
    │   ├── Agenda panel toggle button
    │   └── DisconnectButton (leave)
    ├── RoomAudioRenderer
    └── ConnectionStateToast
```

### Implementation Phases

#### Phase 1: Pre-join screen

Replace the current name-entry form with LiveKit's `PreJoin` component.

**File: [frontend/app/room/[id]/page.tsx](frontend/app/room/[id]/page.tsx)** — Major rewrite of the pre-join section (lines 49-84).

- `PreJoin` renders **outside** `LiveKitRoom` (it only accesses local media, no server connection)
- `PreJoin` includes its own name input field — replaces the current custom form entirely (single-step flow)
- On submit, `PreJoin` returns `LocalUserChoices` (username, audioEnabled, videoEnabled, audioDeviceId, videoDeviceId)
- Use `onSubmit` callback to fetch the token from `/api/token` with the chosen username, then render `LiveKitRoom` with `audio={choices.audioEnabled}` and `video={choices.videoEnabled}`
- Use `onError` to show a toast/alert if device access fails
- Add `onValidate` to require a non-empty username
- Style with Tailwind to match dark theme; override `--lk-*` CSS variables

**Decision: PreJoin replaces the name form entirely.** No two-step flow. User sees camera preview, mic preview, name input, and Join button all in one screen.

```tsx
// Pseudocode for pre-join flow
function RoomPage() {
  const [preJoinChoices, setPreJoinChoices] = useState(null);
  const [token, setToken] = useState(null);

  if (!preJoinChoices) {
    return (
      <PreJoin
        defaults={{ username: '', videoEnabled: true, audioEnabled: true }}
        onSubmit={async (values) => {
          const token = await fetchToken(roomName, values.username);
          setToken(token);
          setPreJoinChoices(values);
        }}
        onValidate={(values) => !!values.username.trim()}
      />
    );
  }

  return (
    <LiveKitRoom
      token={token}
      serverUrl={LIVEKIT_URL}
      connect={true}
      audio={preJoinChoices.audioEnabled}
      video={preJoinChoices.videoEnabled}
    >
      <MeetingRoom roomName={roomName} />
    </LiveKitRoom>
  );
}
```

#### Phase 2: Custom video grid with bot avatar tile

Replace the current `MeetingRoom` component layout entirely.

**New file: [frontend/components/SmartParticipantTile.tsx](frontend/components/SmartParticipantTile.tsx)**

A custom participant tile that renders differently for bot vs human:

- **Detect bot:** `participant.kind === ParticipantKind.AGENT` (primary), with fallback to `identity.startsWith("agent-")` for compatibility
- **Human tile (camera on):** `VideoTrack` + `ParticipantName` + `ConnectionQualityIndicator` + `TrackMutedIndicator`
- **Human tile (camera off):** Initials placeholder (first letter of name, centered in dark tile) + same metadata
- **Bot tile:** Custom avatar (robot icon or animated waveform) + `ParticipantName` ("Beat Your Meet") + pulsing border when `data-lk-speaking="true"` via CSS

Uses `useParticipantTile` hook for data attributes and `useTrackRefContext` for track access.

**Modified file: [frontend/app/room/[id]/page.tsx](frontend/app/room/[id]/page.tsx)** — Replace `MeetingRoom` internals.

```tsx
// Pseudocode for custom video grid
function MeetingRoom({ roomName }) {
  const tracks = useTracks([
    { source: Track.Source.Camera, withPlaceholder: true },
    { source: Track.Source.ScreenShare, withPlaceholder: false },
  ]);

  return (
    <div className="h-screen flex flex-col" data-lk-theme="default">
      <FocusContextProvider>
        <GridLayout tracks={tracks} className="flex-1">
          <SmartParticipantTile />
        </GridLayout>
      </FocusContextProvider>
      <CustomControlBar />
      <RoomAudioRenderer />
      <ConnectionStateToast />
      <FloatingAgendaPanel />
    </div>
  );
}
```

**Bot avatar design decision:** Use a simple robot/AI SVG icon (inline, no external dependency) with the name "Beat Your Meet" below it. When speaking, apply a pulsing colored border ring via CSS `data-lk-speaking` attribute.

```css
/* Bot speaking animation */
.bot-tile[data-lk-speaking='true'] {
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.7);
  animation: pulse-ring 1.5s ease-in-out infinite;
}
```

#### Phase 3: Custom control bar

**New file: [frontend/components/CustomControlBar.tsx](frontend/components/CustomControlBar.tsx)**

Build a custom control bar since LiveKit's `ControlBar` doesn't support injecting custom buttons.

Uses LiveKit building blocks:
- `TrackToggle` for `Track.Source.Microphone`
- `TrackToggle` for `Track.Source.Camera`
- Custom agenda panel toggle button (icon button that toggles panel visibility)
- `DisconnectButton` for leave (navigates to `/` on disconnect)
- `StartAudio` for browser autoplay policy compliance

Layout: Centered at bottom of viewport, horizontal row, dark background bar. Order: mic | camera | agenda toggle | leave.

**No leave confirmation dialog** — matches current behavior and keeps things simple.

#### Phase 4: Floating agenda panel

**New file: [frontend/components/FloatingAgendaPanel.tsx](frontend/components/FloatingAgendaPanel.tsx)**

A floating, draggable overlay panel that wraps the existing `AgendaDisplay` component.

- **Positioning:** Absolute positioned over the video grid. Default position: top-right corner.
- **Dragging:** Native pointer events (`onPointerDown`, `onPointerMove`, `onPointerUp`) with `useState` for `{ x, y }` position. No external drag library needed.
- **Boundary clamping:** Constrain to viewport bounds so the panel can't be dragged off-screen.
- **Toggle:** Controlled by parent via `isOpen` prop; toggle button lives in `CustomControlBar`.
- **Default state:** Open by default. Users can close it via the control bar toggle or a close button on the panel header.
- **Size:** Fixed width (~320px), auto height based on content. Panel header with title "Agenda" and a close (X) button.
- **z-index:** Above the video grid but below any modals.
- **No persistence:** Position resets on reconnect/reload (not worth the complexity).

The `useDataChannel("agenda", onDataReceived)` hook stays in the `MeetingRoom` component and passes `agendaState` down to `FloatingAgendaPanel` → `AgendaDisplay` as a prop.

**File: [frontend/components/AgendaDisplay.tsx](frontend/components/AgendaDisplay.tsx)** — No changes needed. It already accepts agenda state as props.

#### Phase 5: Dark theme CSS overrides

**File: [frontend/app/globals.css](frontend/app/globals.css)** — Add LiveKit CSS variable overrides.

```css
[data-lk-theme='default'] {
  --lk-bg: #0a0a0a;
  --lk-bg-secondary: #1a1a1a;
  --lk-bg-tertiary: #111111;
  --lk-fg: #ededed;
  --lk-fg-secondary: #cccccc;
  --lk-fg-tertiary: #999999;
  --lk-control-bg: #1a1a1a;
  --lk-control-fg: #ededed;
  --lk-accent-bg: #3b82f6;
  --lk-accent-fg: #ffffff;
}
```

Also add styles for the bot tile, floating panel, and any Tailwind overrides for LiveKit component integration.

#### Phase 6: Make explicit video grants in token (optional but recommended)

**File: [server/main.py](server/main.py)** — Update token grants to be explicit (lines ~53-65).

The current `VideoGrants(room_join=True, room=req.room_name)` already grants video by default, but making it explicit improves clarity:

```python
token.with_grants(
    api.VideoGrants(
        room_join=True,
        room=req.room_name,
        can_publish=True,
        can_subscribe=True,
        can_publish_data=True,
    )
)
```

No agent changes needed — agent correctly uses `AutoSubscribe.AUDIO_ONLY`.

## Acceptance Criteria

### Functional Requirements

- [ ] Pre-join screen shows camera preview, mic level indicator, device selectors, name input, and Join button
- [ ] Joining with camera on shows user's video in a tile in the grid
- [ ] Joining with camera off shows initials placeholder in the tile
- [ ] AI bot appears as a tile with custom avatar and name "Beat Your Meet"
- [ ] Bot tile shows pulsing border animation when bot is speaking
- [ ] Video grid is responsive — adapts layout to 2, 3, 4, 5+ participants
- [ ] Control bar has mic toggle, camera toggle, agenda panel toggle, and leave button
- [ ] Floating agenda panel shows current agenda state received via data channel
- [ ] Agenda panel can be toggled open/closed from the control bar
- [ ] Agenda panel can be dragged to reposition within viewport bounds
- [ ] Leaving the meeting disconnects and navigates to `/`
- [ ] Dark theme is consistent across all LiveKit components and custom UI

### Edge Cases Handled

- [ ] No camera device available → user can still join audio-only, no error
- [ ] Browser denies camera/mic permissions → PreJoin shows error, user can retry
- [ ] Bot joins after user → tile appears dynamically in grid
- [ ] Bot disconnects → tile disappears (no special handling needed for MVP)
- [ ] Late joiner sees "Loading agenda..." until first data channel message (up to 15s)

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `frontend/app/room/[id]/page.tsx` | **Rewrite** | PreJoin flow + custom MeetingRoom with GridLayout |
| `frontend/components/SmartParticipantTile.tsx` | **Create** | Custom tile renderer (human video/placeholder + bot avatar) |
| `frontend/components/CustomControlBar.tsx` | **Create** | Custom control bar with agenda toggle |
| `frontend/components/FloatingAgendaPanel.tsx` | **Create** | Draggable floating wrapper for AgendaDisplay |
| `frontend/components/AgendaDisplay.tsx` | No change | Already works as a controlled component |
| `frontend/components/ParticipantList.tsx` | **Delete** | Replaced by video grid tiles |
| `frontend/app/globals.css` | **Edit** | Add LiveKit dark theme CSS variable overrides |
| `server/main.py` | **Edit** | Make video grants explicit (optional) |

## Dependencies & Risks

**No new packages required.** All functionality is available in the already-installed:
- `@livekit/components-react@^2` (v2.9.20 resolved)
- `@livekit/components-styles@^1`
- `livekit-client@^2` (v2.17.2 resolved)

**Risks:**
- LiveKit `PreJoin` component styling may need significant CSS overrides to match the dark theme
- `GridLayout` behavior with mixed video/audio-only/bot tiles needs testing — grid sizing for placeholder tiles may look odd
- Draggable panel with native pointer events needs touch event handling for tablet users

## References & Research

### Internal References
- Brainstorm: [docs/brainstorms/2026-02-28-livekit-meet-room-ui-brainstorm.md](docs/brainstorms/2026-02-28-livekit-meet-room-ui-brainstorm.md)
- Current room page: [frontend/app/room/[id]/page.tsx](frontend/app/room/[id]/page.tsx)
- Current agent: [agent/main.py](agent/main.py) (no changes needed)
- Current server: [server/main.py](server/main.py) (minor explicit grants update)
- Existing learnings: [docs/solutions/runtime-errors/silent-agent-crash-elevenlabs-param-rename.md](docs/solutions/runtime-errors/silent-agent-crash-elevenlabs-param-rename.md) — breadcrumb logging patterns

### External References
- [LiveKit React Components Reference](https://docs.livekit.io/reference/components/react/)
- [VideoConference Source Code](https://github.com/livekit/components-js/blob/main/packages/react/src/prefabs/VideoConference.tsx)
- [PreJoin Component Docs](https://docs.livekit.io/reference/components/react/component/prejoin/)
- [Custom Components Guide](https://docs.livekit.io/reference/components/react/concepts/custom-components/)
- [Styling LiveKit Components](https://docs.livekit.io/reference/components/react/concepts/style-components/)
- [LiveKit Meet Example](https://github.com/livekit-examples/meet)
- [ParticipantKind (livekit-client)](https://docs.livekit.io/reference/client-sdk-js/classes/Participant.html)
