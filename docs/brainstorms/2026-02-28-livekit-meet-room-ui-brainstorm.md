# Brainstorm: LiveKit Meet-Style Meeting Room UI

**Date:** 2026-02-28
**Status:** Ready for planning
**Feature:** Replace the simple audio-only meeting room UI with a full video conferencing room inspired by LiveKit Meet

---

## What We're Building

A production-quality meeting room UI that supports audio + video with a responsive participant video grid, pre-join device preview screen, and the AI facilitator bot visible as an avatar tile in the grid. The existing agenda tracker becomes a floating overlay panel on top of the video grid.

### In Scope
- **Pre-join screen**: Camera/mic preview, device selection, name input (using LiveKit `PreJoin` component)
- **Video grid**: Responsive participant tiles with video feeds, name labels, speaking indicators (using LiveKit `VideoConference` composite)
- **Control bar**: Mic toggle, camera toggle, leave button, agenda panel toggle (using LiveKit `ControlBar` + custom buttons)
- **Bot avatar tile**: AI agent appears in the grid with a custom avatar/icon and animated speaking indicator
- **Floating agenda panel**: Existing `AgendaDisplay` wrapped in a draggable, toggleable floating panel overlaid on the video
- **Server token update**: Grant video publish/subscribe permissions (currently audio-only)

### Out of Scope
- Screen sharing
- Text chat sidebar
- Recording/egress
- E2E encryption
- Virtual backgrounds / video effects
- Mobile-specific responsive design (beyond basic Tailwind breakpoints)

---

## Why This Approach

**Use `@livekit/components-react` composite components** customized with Tailwind CSS.

### Rationale
- The three core LiveKit packages (`@livekit/components-react`, `@livekit/components-styles`, `livekit-client`) are already installed
- Composite components (`VideoConference`, `PreJoin`, `ControlBar`) handle WebRTC complexity, adaptive streaming, responsive grid layout, and accessibility out of the box
- Customizable via Tailwind and CSS variable overrides to match the existing dark theme (`#0a0a0a` background)
- The unique value-add (agenda tracking + AI facilitation) stays prominent as a floating overlay rather than competing with the video grid for layout space

### Trade-offs
- Less pixel-perfect design control than fully custom components, but Tailwind overrides and `data-lk-*` attribute selectors provide sufficient customization
- Dependency on LiveKit component library updates, mitigated by pinning versions

---

## Key Decisions

1. **Audio + Video**: The room will support full video, not just audio. Camera is on by default but can be toggled off.

2. **LiveKit composite components over custom hooks**: Use `VideoConference`, `PreJoin`, `ControlBar` for the heavy lifting. Faster to build, well-tested, production-ready.

3. **Floating agenda panel**: Agenda tracker overlays the video grid as a draggable/toggleable panel (like a floating chat window), rather than a sidebar or bottom drawer. This maximizes video grid space.

4. **Bot visible in grid**: The AI facilitator agent appears as a participant tile with a custom avatar and speaking animation. Makes its presence tangible.

5. **Existing dark theme preserved**: All LiveKit components styled to match the current `#0a0a0a` dark theme via CSS variable overrides.

---

## Open Questions

1. **Bot avatar design**: What icon/avatar should the bot tile display? An animated waveform? A logo? A robot icon?
2. **Agenda panel default state**: Should the floating agenda panel be open by default when joining, or collapsed/hidden?
3. **Pre-join flow**: Should the pre-join screen replace the current name-entry form entirely, or should users still enter a name on a separate step before seeing device preview?

---

## Technical Context

### Current State
- Next.js (App Router) with 2 pages and 4 components
- LiveKit packages already installed: `@livekit/components-react@^2`, `@livekit/components-styles@^1`, `livekit-client@^2`
- Audio-only: `video={false}` in `LiveKitRoom`, token only grants audio permissions
- Agenda state received via LiveKit data channel on `"agenda"` topic
- No global state management — all `useState` in components

### Files to Modify
- `frontend/app/room/[id]/page.tsx` — Major rewrite: pre-join screen + video conference room
- `frontend/components/AgendaDisplay.tsx` — Wrap in floating panel container
- `server/main.py` — Update token generation to include video permissions
- `frontend/app/globals.css` — Add LiveKit component style overrides

### Files to Create
- `frontend/components/FloatingAgendaPanel.tsx` — Draggable floating container for agenda
- `frontend/components/BotAvatar.tsx` — Custom avatar tile for the AI agent participant
- `frontend/components/ControlBarExtras.tsx` — Custom control bar buttons (agenda toggle)

### New Dependencies
- None required — existing LiveKit packages support all needed features
- Optional: a lightweight drag library if CSS-only drag feels insufficient
