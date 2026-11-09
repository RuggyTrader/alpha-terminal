import { markets, systemHealth } from "../health";
import type { FeedState } from "../poller";
import { SectionHeader, StatusBadge } from "./ui";

/** Asset classes and whether each is genuinely connected. */
export function MarketsCard({ state, now = Date.now() }: { state: FeedState; now?: number }) {
  const rows = markets(state.data, now);
  return (
    <section className="card dark-card mk" aria-label="Markets">
      <SectionHeader title="Markets" />
      <div className="mk-grid">
        {rows.map((r) => (
          <div key={r.cls} className={`mk-cell mk-${r.tone}`}>
            <span className="mk-cls">{r.cls}</span>
            <StatusBadge tone={r.tone} dot={r.state === "ACTIVE"}>{r.state}</StatusBadge>
            <span className="mk-prov">{r.provider === "None" ? "No provider" : r.provider}</span>
            <span className="mk-det">{r.detail}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Genuine status of each part of the system. Nothing unknown is shown as healthy. */
export function SystemHealthCard({ state, now = Date.now() }: { state: FeedState; now?: number }) {
  const rows = systemHealth(state, now);
  const worst = rows.some((r) => r.tone === "bad") ? "bad" : rows.some((r) => r.tone === "warn") ? "warn" : null;
  return (
    <section className="card dark-card health" aria-label="System health">
      <SectionHeader
        title="System health"
        right={worst ? <StatusBadge tone={worst}>{worst === "bad" ? "ATTENTION" : "DEGRADED"}</StatusBadge> : null}
      />
      <ul className="health-list">
        {rows.map((r) => (
          <li key={r.key}>
            <div className="health-l">
              <b>{r.name}</b>
              <span>{r.detail}</span>
            </div>
            <StatusBadge tone={r.tone}>{r.state}</StatusBadge>
          </li>
        ))}
      </ul>
    </section>
  );
}
