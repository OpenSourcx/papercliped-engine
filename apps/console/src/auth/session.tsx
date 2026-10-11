import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, probe, SIGNED_OUT, type LiveUser } from "../data/api.ts";
import { PinOrb } from "../pin/PinIsland.tsx";
import { SignIn } from "./SignIn.tsx";

/**
 * Who is using the console. Served by the host service, everyone signs in with their Proxmox account (Integrated
 * Access Control) and the console runs on live data as that user. Served on its own, it runs on demo data.
 */

export type SessionState = { mode: "live"; user: LiveUser } | { mode: "demo" };

interface SessionCtx {
  session: SessionState;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionCtx>({ session: { mode: "demo" }, signOut: async () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState | { mode: "loading" } | { mode: "signin" }>({ mode: "loading" });

  useEffect(() => {
    let alive = true;
    probe().then((p) => alive && setState(p));
    const onSignedOut = () => setState((s) => (s.mode === "live" ? { mode: "signin" } : s));
    window.addEventListener(SIGNED_OUT, onSignedOut);
    return () => {
      alive = false;
      window.removeEventListener(SIGNED_OUT, onSignedOut);
    };
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setState({ mode: "signin" });
  }, []);

  if (state.mode === "loading") {
    return (
      <div className="min-h-dvh flex items-center justify-center" aria-busy="true">
        <PinOrb size={56} thinking />
        <span className="sr-only">Loading</span>
      </div>
    );
  }
  if (state.mode === "signin") return <SignIn onSignedIn={(user) => setState({ mode: "live", user })} />;
  return <Ctx.Provider value={{ session: state, signOut }}>{children}</Ctx.Provider>;
}

export function useSession() {
  return useContext(Ctx);
}
