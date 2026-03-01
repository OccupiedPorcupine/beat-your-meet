import Link from "next/link";

export default function Home() {
  return (
    <main className="landing-shell">
      <section className="hero-wrap">
        <div className="hero-noise" aria-hidden="true" />
        <div className="hero-flares" aria-hidden="true" />

        <div className="hero-copy">
          <p className="hero-kicker">- BEATYOURMEET</p>
          <h1 className="hero-title">BEATYOURMEET</h1>
          <p className="hero-subtitle">
            THE AI MEETING FACILITATOR THAT KEEPS YOU ON TRACK
          </p>
          <p className="hero-meta">
            Voice-first meeting facilitation
            <br />
            Agenda guardrails, tangent recovery, and time-box awareness
          </p>

          <Link href="/setup" className="hero-cta">
            Start a Meeting
          </Link>
        </div>

        <div className="hero-centerpiece" aria-hidden="true">
          <div className="primitive-orbit">
            <div className="primitive-glow" />
            <div className="geo-stage">
              <div className="geo-primitive">
                <span className="geo-face face-front"><span className="mac-face">=)</span></span>
                <span className="geo-face face-back" />
                <span className="geo-face face-left" />
                <span className="geo-face face-right" />
                <span className="geo-face face-top" />
                <span className="geo-face face-bottom" />
              </div>
              <div className="geo-specular" />
            </div>
          </div>
        </div>

      </section>
    </main>
  );
}
