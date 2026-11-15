// One asset identity for the whole app: the asset's real logo beside (never instead of) its market or bot name.
// Logos are bundled inline SVG (no request per render):
//   Bitcoin  the Bitcoin symbol (public domain, bitcoin.org/en/press "Bitcoin logo" released to the public domain).
//   Solana   the Solana mark from the Solana Foundation brand assets (solana.com/branding), used to identify the asset.
// Unknown assets get an honest neutral fallback (their first letters), never another coin's logo.

const ALIASES: Record<string, "SOL" | "BTC"> = {
  SOL: "SOL", SOLUSD: "SOL", "SOL/USD": "SOL", SOLANA: "SOL", "KRAKEN:SOLUSD": "SOL",
  BTC: "BTC", XBT: "BTC", BTCUSD: "BTC", XBTUSD: "BTC", XXBTZUSD: "BTC", "BTC/USD": "BTC", "XBT/USD": "BTC", BITCOIN: "BTC", "KRAKEN:BTCUSD": "BTC",
};
/** The bots' markets (registry: ALPHA-01/02 Solana, ALPHA-03/04 Bitcoin). */
const BOT_ASSET: Record<string, "SOL" | "BTC"> = { "ALPHA-01": "SOL", "ALPHA-02": "SOL", "ALPHA-03": "BTC", "ALPHA-04": "BTC" };
export const ASSET_NAME: Record<"SOL" | "BTC", string> = { SOL: "Solana", BTC: "Bitcoin" };

/** Normalises any market alias, bot id or asset name to a supported asset, or null when no logo is configured. */
export function assetOf(v: string | null | undefined): "SOL" | "BTC" | null {
  if (!v) return null;
  const k = String(v).trim().toUpperCase().replace(/\s+/g, "");
  if (ALIASES[k]) return ALIASES[k];
  if (BOT_ASSET[k]) return BOT_ASSET[k];
  const bot = /^ALPHA[-\s]?(\d{2})$/.exec(k);
  if (bot && BOT_ASSET[`ALPHA-${bot[1]}`]) return BOT_ASSET[`ALPHA-${bot[1]}`];
  const base = k.replace(/^KRAKEN:/, "").replace(/(\/)?(USD|USDT|USDC|ZUSD)$/, "");
  return ALIASES[base] ?? null;
}

function Bitcoin({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <circle cx="32" cy="32" r="32" fill="#F7931A" />
      <path fill="#FFFFFF" d="M46.1 27.4c.6-4.3-2.6-6.6-7.1-8.1l1.5-5.8-3.5-.9-1.4 5.7c-.9-.2-1.9-.4-2.8-.7l1.4-5.7-3.5-.9-1.5 5.8c-.8-.2-1.5-.3-2.2-.5l-4.9-1.2-.9 3.8s2.6.6 2.6.6c1.4.4 1.7 1.3 1.6 2.1l-4 16.1c-.2.4-.6 1-1.6.8 0 .1-2.6-.6-2.6-.6l-1.7 4 4.6 1.2c.9.2 1.7.4 2.5.6l-1.5 5.9 3.5.9 1.5-5.8c1 .3 1.9.5 2.8.7l-1.4 5.8 3.5.9 1.5-5.9c6 1.1 10.5.7 12.4-4.8 1.5-4.4-.1-6.9-3.2-8.6 2.3-.5 4-2 4.5-5.1zm-8 11.2c-1.1 4.4-8.4 2-10.8 1.4l1.9-7.7c2.4.6 10 1.8 8.9 6.3zm1.1-11.3c-1 4-7.1 2-9.1 1.5l1.8-7c2 .5 8.4 1.4 7.3 5.5z" />
    </svg>
  );
}

let gid = 0;
function Solana({ size }: { size: number }) {
  const id = `sol-g-${(gid += 1)}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="360.9" y1="-37.5" x2="141.2" y2="383.3" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#00FFA3" />
          <stop offset="1" stopColor="#DC1FFF" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="32" fill="#000000" />
      <g transform="translate(14.1 18.0) scale(0.09)">
        <path fill={`url(#${id})`} d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" />
        <path fill={`url(#${id})`} d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" />
        <path fill={`url(#${id})`} d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z" />
      </g>
    </svg>
  );
}

/**
 * The asset's logo, from a symbol, alias or bot id. `label` is the accessible name (defaults to the asset name, or
 * the raw symbol for an unsupported asset). Decorative when the name is already written beside it: pass decorative.
 */
export function AssetLogo({ of, size = 20, decorative = false, className = "" }: { of: string | null | undefined; size?: number; decorative?: boolean; className?: string }) {
  const a = assetOf(of);
  const label = a ? ASSET_NAME[a] : String(of ?? "Unknown asset");
  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img", "aria-label": label };
  if (!a) {
    const letters = String(of ?? "?").replace(/^KRAKEN:/i, "").replace(/(USD|USDT|USDC)$/i, "").slice(0, 3).toUpperCase() || "?";
    return (
      <span className={`asset-logo asset-logo-fallback ${className}`} style={{ width: size, height: size, fontSize: Math.max(7, size * 0.36) }} {...a11y} title={decorative ? undefined : `${label} (no logo configured)`}>
        {letters}
      </span>
    );
  }
  return (
    <span className={`asset-logo ${className}`} style={{ width: size, height: size }} {...a11y} title={decorative ? undefined : label} data-asset={a}>
      {a === "BTC" ? <Bitcoin size={size} /> : <Solana size={size} />}
    </span>
  );
}
