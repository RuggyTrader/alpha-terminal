import { logout } from "./api";
import { TerminalView } from "./TerminalView";
import { useDashboard } from "./useDashboard";

export function Terminal({ onSignedOut, onExpired }: { onSignedOut: () => void; onExpired: () => void }) {
  const { state, refresh } = useDashboard(onExpired);
  const signOut = async () => {
    try {
      await logout();
    } catch {
      // The local session view is cleared either way; the cookie expires server-side.
    } finally {
      onSignedOut();
    }
  };
  return <TerminalView state={state} onRefresh={refresh} onSignOut={() => void signOut()} />;
}
