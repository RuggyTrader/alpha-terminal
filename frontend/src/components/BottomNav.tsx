import { NavLink } from "react-router-dom";
import { Icon, type IconName } from "./icons";

const SIDE: { to: string; label: string; icon: IconName; end?: boolean }[][] = [
  [{ to: "/", label: "Home", icon: "home", end: true }, { to: "/trades", label: "Trades", icon: "trades" }],
  [{ to: "/activity", label: "Activity", icon: "activity" }, { to: "/settings", label: "Settings", icon: "settings" }],
];

function Item({ to, label, icon, end }: { to: string; label: string; icon: IconName; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-item${isActive ? " on" : ""}`}>
      <Icon name={icon} size={22} />
      <span>{label}</span>
    </NavLink>
  );
}

export function BottomNav({ engineState }: { engineState: string | null }) {
  return (
    <nav className="nav" aria-label="Main">
      <div className="nav-inner">
        {SIDE[0].map((i) => <Item key={i.to} {...i} />)}
        <NavLink to="/engine" className={({ isActive }) => `nav-engine${isActive ? " on" : ""}`}>
          <Icon name="bolt" size={15} fill />
          <span>Engine</span>
          {engineState && <i className={`nav-engine-dot ${engineState}`} aria-label={`engine ${engineState}`} />}
        </NavLink>
        {SIDE[1].map((i) => <Item key={i.to} {...i} />)}
      </div>
    </nav>
  );
}
