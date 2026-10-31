import { useState } from "react";
import { logout } from "./api";
import { idleSignOut, performSignOut, type SignOutState } from "./signOut";
import { TerminalView } from "./TerminalView";
import { useDashboard } from "./useDashboard";

export function Terminal({ onSignedOut, onExpired }: { onSignedOut: () => void; onExpired: () => void }) {
  const { state, refresh } = useDashboard(onExpired);
  const [signOut, setSignOut] = useState<SignOutState>(idleSignOut);

  const doSignOut = async () => {
    if (signOut.busy) return;
    setSignOut({ busy: true, error: null });
    const result = await performSignOut(logout);
    if (result.ok) {
      onSignedOut();
    } else {
      setSignOut({ busy: false, error: result.message });
    }
  };

  return (
    <TerminalView
      state={state}
      signOut={signOut}
      onRefresh={refresh}
      onSignOut={() => void doSignOut()}
      onDismissSignOutError={() => setSignOut(idleSignOut)}
    />
  );
}
