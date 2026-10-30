const PATHS = {
  home: "M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z",
  trades: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  bolt: "M13 2 4.5 13.5H11L10 22l8.5-11.5H12z",
  activity: "M3 12h4l2.5-6 4 12 2.5-6H21",
  settings: "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM19 12c0-.5 0-.9-.1-1.3l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2.2-1.3L14 3h-4l-.4 2.4a7 7 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2.2 1.3L10 21h4l.4-2.4a7 7 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.3z",
  back: "M15 5l-7 7 7 7",
  chevron: "M9 6l6 6-6 6",
  close: "M6 6l12 12M18 6 6 18",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22, fill = false }: { name: IconName; size?: number; fill?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** ALPHA TERMINAL mark: an original alpha glyph in a rounded tile. */
export function Mark({ size = 24, light = false }: { size?: number; light?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill={light ? "#FFFFFF" : "#15130F"} />
      <path d="M21.5 11.2c-.9 3.9-2.6 9.6-6.4 9.6-2.7 0-4.3-2.3-4.3-4.9 0-3 2.1-5.2 4.6-5.2 3.6 0 4.2 4.3 7 10.1"
        fill="none" stroke="#F2661B" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Original hero visual: a white geometric sphere with an engraved alpha. */
export function HeroOrb() {
  return (
    <svg className="hero-orb" viewBox="0 0 220 220" aria-hidden>
      <defs>
        <radialGradient id="orbFill" cx="38%" cy="30%" r="75%">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.62" stopColor="#ECE8E1" />
          <stop offset="1" stopColor="#B9B2A6" />
        </radialGradient>
        <radialGradient id="orbGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#F2661B" stopOpacity="0.38" />
          <stop offset="1" stopColor="#F2661B" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="120" cy="96" r="110" fill="url(#orbGlow)" />
      <circle cx="110" cy="118" r="96" fill="url(#orbFill)" />
      <g fill="none" stroke="#15130F" strokeOpacity="0.07" strokeWidth="1.4">
        <ellipse cx="110" cy="118" rx="96" ry="34" />
        <ellipse cx="110" cy="118" rx="96" ry="66" />
        <ellipse cx="110" cy="118" rx="34" ry="96" />
        <ellipse cx="110" cy="118" rx="66" ry="96" />
      </g>
      <path d="M140 92c-3.2 13.5-9 33.5-22.3 33.5-9.4 0-15-8-15-17 0-10.5 7.3-18 16-18 12.5 0 14.6 15 24.4 35.2"
        fill="none" stroke="#15130F" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
