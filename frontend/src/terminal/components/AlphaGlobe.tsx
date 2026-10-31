import { useEffect, useRef, useState } from "react";
import { HeroOrb } from "../../components/icons";
import { prefersReducedMotion } from "../motion";

/**
 * The α globe with small, state-driven motion:
 * - idle: slow 3 px float (CSS, transform only)
 * - mount: gentle scale/fade entrance
 * - `refreshKey` changes (real account value changed): short tilt
 * - `tiltKey` changes (market open/closed, engine state): small orbit shift
 * - `reconnected`: one soft glow
 * - tap: quick squash and spring back
 * All one-shot animations use the Web Animations API and are skipped with reduced motion.
 */
export function AlphaGlobe({
  refreshKey,
  tiltKey,
  reconnected = false,
  className = "",
}: {
  refreshKey?: unknown;
  tiltKey?: unknown;
  reconnected?: boolean;
  className?: string;
}) {
  const react = useRef<HTMLDivElement>(null);
  const prevRefresh = useRef(refreshKey);
  const prevTilt = useRef(tiltKey);
  const [glow, setGlow] = useState(false);

  const play = (frames: Keyframe[], duration: number) => {
    const el = react.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== "function") return;
    el.animate(frames, { duration, easing: "cubic-bezier(0.22, 0.8, 0.24, 1)" });
  };

  useEffect(() => {
    if (!Object.is(prevRefresh.current, refreshKey) && prevRefresh.current !== undefined && refreshKey !== undefined) {
      play([{ transform: "rotate(0deg)" }, { transform: "rotate(-9deg) scale(1.02)" }, { transform: "rotate(0deg)" }], 700);
    }
    prevRefresh.current = refreshKey;
  }, [refreshKey]);

  useEffect(() => {
    if (!Object.is(prevTilt.current, tiltKey) && prevTilt.current !== undefined && tiltKey !== undefined) {
      play([{ transform: "translateX(0) rotate(0deg)" }, { transform: "translateX(5px) rotate(6deg)" }, { transform: "translateX(0) rotate(0deg)" }], 650);
    }
    prevTilt.current = tiltKey;
  }, [tiltKey]);

  useEffect(() => {
    if (!reconnected || prefersReducedMotion()) return;
    setGlow(true);
    const t = window.setTimeout(() => setGlow(false), 1600);
    return () => window.clearTimeout(t);
  }, [reconnected]);

  const tap = () =>
    play(
      [
        { transform: "scale(1) rotate(0deg)" },
        { transform: "scale(0.92, 0.96) rotate(-4deg)", offset: 0.35 },
        { transform: "scale(1.03) rotate(2deg)", offset: 0.7 },
        { transform: "scale(1) rotate(0deg)" },
      ],
      420,
    );

  return (
    <div className={`globe ${glow ? "is-reconnected" : ""} ${className}`} onPointerDown={tap} aria-hidden>
      <div className="globe-float">
        <div className="globe-react" ref={react}>
          <HeroOrb />
        </div>
      </div>
      <i className="globe-glow" />
    </div>
  );
}
