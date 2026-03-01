"use client";

import { Suspense } from "react";
import PostMeetingPageInner from "./PostMeetingPageInner";

function LoadingScreen() {
  return (
    <main className="post-shell">
      <div className="post-noise" aria-hidden="true" />
      <div className="post-glow" aria-hidden="true" />
      <div className="post-loading">
        <div className="post-spinner" aria-hidden="true" />
        <p>Loading meeting documents…</p>
      </div>
    </main>
  );
}

export default function PostMeetingPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <PostMeetingPageInner />
    </Suspense>
  );
}
