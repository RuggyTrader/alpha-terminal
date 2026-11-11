import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../../api/client";
import {
  currentSubscription, deviceStatus, disableOnDevice, enableOnDevice, fetchNotifyConfig, probe, savePrefs, sendTest, support,
  type NotifyConfig, type NotifyPrefs, type Support,
} from "../notifications";

const errText = (e: unknown) => (e instanceof ApiError ? (e.status === 0 && e.code === "PERMISSION_DENIED" ? e.message : `${e.code}: ${e.message}`) : e instanceof Error ? e.message : "Something went wrong; nothing was changed.");

const TYPE_ROWS: { k: keyof NotifyPrefs; t: string; s: string }[] = [
  { k: "funded_entry", t: "ALPHA PAPER entries", s: "Simulated PAPER fills, with quantity and price" },
  { k: "funded_close", t: "ALPHA PAPER exits", s: "Closed PAPER trades, P&L from the ledger after fees" },
  { k: "mirror_entry", t: "Strategy Mirror entries", s: "Hypothetical fills of the original strategy" },
  { k: "mirror_close", t: "Strategy Mirror exits", s: "Hypothetical gross result, plus modelled net" },
];
const DETAIL_ROWS: { k: keyof NotifyPrefs; t: string; s: string }[] = [
  { k: "include_pnl", t: "Include P&L", s: "Show the result in exit notifications" },
  { k: "hide_amounts", t: "Hide amounts on the lock screen", s: "No prices, quantities or P&L in the notification text" },
  { k: "include_catch_up", t: "Catch-up events", s: "Trades processed late after the engine was offline" },
  { k: "include_historical", t: "Historical events", s: "Warm-up replays of past candles (off: live only)" },
];

function Switch({ k, t, s, prefs, onChange, disabled }: { k: keyof NotifyPrefs; t: string; s: string; prefs: NotifyPrefs; onChange: (k: keyof NotifyPrefs, v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="remember nt-row">
      <input type="checkbox" checked={prefs[k]} disabled={disabled} onChange={(e) => onChange(k, e.target.checked)} />
      <span className="remember-switch" aria-hidden />
      <span className="remember-text">
        <b>{t}</b>
        <small>{s}</small>
      </span>
    </label>
  );
}

function IosSteps() {
  return (
    <ol className="nt-steps">
      <li>Open ALPHA TERMINAL in <b>Safari</b> on the iPhone (iOS 16.4 or later).</li>
      <li>Tap <b>Share</b>, then <b>Add to Home Screen</b>, then <b>Add</b>.</li>
      <li>Open ALPHA TERMINAL from the new Home Screen icon and sign in.</li>
      <li>Come back to Settings → Notifications and tap <b>Enable</b>; allow notifications when iOS asks.</li>
    </ol>
  );
}

type View =
  | { s: "loading" }
  | { s: "unsupported"; why: Exclude<Support, { ok: true }>["why"] }
  | { s: "unavailable"; reason: string }
  | { s: "off"; cfg: NotifyConfig; denied: boolean; stale?: boolean }
  | { s: "on"; cfg: NotifyConfig; sub: PushSubscription; lastOk: string | null; lastErr: string | null };

/** Settings → Notifications: per-device Web Push, entirely opt-in. */
export function NotificationSettings() {
  const [view, setView] = useState<View>({ s: "loading" });
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const sup = support(probe());
      if (!sup.ok) return alive && setView({ s: "unsupported", why: sup.why });
      let cfg: NotifyConfig;
      try {
        cfg = await fetchNotifyConfig();
      } catch (e) {
        return alive && setView({ s: "unavailable", reason: errText(e) });
      }
      if (!cfg.available) return alive && setView({ s: "unavailable", reason: cfg.reason ?? "Notifications are not set up on the Worker yet." });
      const denied = typeof Notification !== "undefined" && Notification.permission === "denied";
      const sub = await currentSubscription().catch(() => null);
      if (sub) {
        try {
          const st = await deviceStatus(sub.endpoint);
          if (!alive) return;
          setPrefs(st.prefs);
          if (st.active) return setView({ s: "on", cfg, sub, lastOk: st.last_success_at, lastErr: st.last_error });
        } catch {
          /* not stored on the Worker (expired or removed): show as off, needing re-enable */
        }
        if (alive) {
          setPrefs((p) => p ?? cfg.defaults);
          setView({ s: "off", cfg, denied, stale: true });
        }
        return;
      }
      if (alive) {
        setPrefs(cfg.defaults);
        setView({ s: "off", cfg, denied });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const enable = async (e: FormEvent) => {
    e.preventDefault();
    if (view.s !== "off" || !prefs || !pass || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await enableOnDevice(view.cfg, pass, { ...prefs, enabled: true });
      setPass("");
      setPrefs(r.prefs);
      setView({ s: "on", cfg: view.cfg, sub: r.sub, lastOk: null, lastErr: null });
      setMsg({ tone: "good", text: "Notifications are on for this device." });
    } catch (err) {
      const denied = typeof Notification !== "undefined" && Notification.permission === "denied";
      setView({ ...view, denied });
      setMsg({ tone: "bad", text: errText(err) });
    } finally {
      setBusy(false);
    }
  };

  const change = async (k: keyof NotifyPrefs, v: boolean) => {
    if (!prefs) return;
    const next = { ...prefs, [k]: v };
    setPrefs(next);
    if (view.s !== "on") return; // saved when the device is enabled
    setMsg(null);
    try {
      setPrefs(await savePrefs(view.sub.endpoint, next));
    } catch (err) {
      setPrefs(prefs);
      setMsg({ tone: "bad", text: errText(err) });
    }
  };

  const test = async () => {
    if (view.s !== "on" || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await sendTest(view.sub.endpoint);
      setMsg(r.sent > 0 ? { tone: "good", text: "Test sent. It should arrive within a few seconds." } : { tone: "bad", text: "The push service did not accept the test; try again later." });
    } catch (err) {
      setMsg({ tone: "bad", text: errText(err) });
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (view.s !== "on" || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await disableOnDevice(view.sub);
      setView({ s: "off", cfg: view.cfg, denied: false });
      setMsg({ tone: "good", text: "Notifications are off for this device." });
    } catch (err) {
      setMsg({ tone: "bad", text: errText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sg" aria-label="Notifications">
      <h2 className="sg-t">Notifications</h2>
      <p className="sg-sub">Alerts for ALPHA PAPER fills and exits and Strategy Mirror (hypothetical) trades. Delivery depends on this device's notification permission, Focus settings and the push service; a missed notification never affects trading.</p>
      <div className="card sg-card nt-card">
        {view.s === "loading" ? <p className="nt-note">Checking this device…</p> : null}

        {view.s === "unsupported" ? (
          view.why === "needs-home-screen" ? (
            <>
              <p className="nt-note"><b>On iPhone, notifications work only in the Home Screen app.</b></p>
              <IosSteps />
            </>
          ) : (
            <p className="nt-note">{view.why === "insecure" ? "Notifications need a secure (https) connection." : "This browser does not support Web Push notifications."}</p>
          )
        ) : null}

        {view.s === "unavailable" ? <p className="nt-note">Not available yet: {view.reason}</p> : null}

        {view.s === "off" && prefs ? (
          <form className="nt-form" onSubmit={enable}>
            {view.stale ? <p className="nt-note nt-warn">This device's earlier subscription is no longer active. Enable again to resume.</p> : null}
            {view.denied ? (
              <p className="nt-note nt-warn">Notifications are blocked for this app. Allow them in the device settings (iPhone: Settings → Notifications → ALPHA TERMINAL), then try again.</p>
            ) : null}
            <div className="nt-group">{TYPE_ROWS.map((r) => <Switch key={r.k} {...r} prefs={prefs} onChange={change} />)}</div>
            <div className="nt-group">{DETAIL_ROWS.map((r) => <Switch key={r.k} {...r} prefs={prefs} onChange={change} />)}</div>
            <label className="pf-field">
              <span>Passphrase (confirms enabling this device)</span>
              <input type="password" autoComplete="current-password" value={pass} onChange={(e) => { setPass(e.target.value); setMsg(null); }} />
            </label>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !pass}>{busy ? "Enabling…" : "Enable notifications"}</button>
          </form>
        ) : null}

        {view.s === "on" && prefs ? (
          <div className="nt-form">
            <p className="nt-note"><b className="t-ok">On for this device.</b>{view.lastOk ? ` Last delivered ${view.lastOk.slice(0, 16).replace("T", " ")} UTC.` : ""}{view.lastErr ? ` Last error: ${view.lastErr}` : ""}</p>
            <div className="nt-group">{TYPE_ROWS.map((r) => <Switch key={r.k} {...r} prefs={prefs} onChange={(k, v) => void change(k, v)} />)}</div>
            <div className="nt-group">{DETAIL_ROWS.map((r) => <Switch key={r.k} {...r} prefs={prefs} onChange={(k, v) => void change(k, v)} />)}</div>
            <div className="nt-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void test()} disabled={busy}>Send test notification</button>
              <button type="button" className="btn btn-ghost btn-sm nt-off" onClick={() => void disable()} disabled={busy}>Disable for this device</button>
            </div>
          </div>
        ) : null}

        {msg ? <p className={`pf-msg pf-msg-${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"}>{msg.text}</p> : null}
      </div>
    </section>
  );
}
