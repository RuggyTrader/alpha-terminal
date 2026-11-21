// The BTC daily trend forward trial (research, isolated from the funded PAPER portfolio). Its panel, data, owner
// controls and authentication are unchanged; it simply lives here, outside the four main tabs, reached from Settings.
import { Link } from "react-router-dom";
import { TrialPanel } from "../components/TrialPanel";
import { S3ShadowPanel } from "../components/S3ShadowPanel";
import { TRIAL_DISPLAY_NAME } from "../botNames";
import { SectionHeader } from "../components/ui";

export function ResearchTrialPage() {
  return (
    <div className="page-stack">
      <SectionHeader title={`Research · ${TRIAL_DISPLAY_NAME}`} sub="BTC daily trend forward trial · its own $100 research account · never part of the funded PAPER results"
        right={<Link className="link" to="/settings">Settings</Link>} />
      <TrialPanel />
      <S3ShadowPanel />
    </div>
  );
}
