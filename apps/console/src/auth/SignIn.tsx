import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { api, ApiError, type LiveUser, type Realm } from "../data/api.ts";
import { cn } from "../lib/storage.ts";
import { PinOrb } from "../pin/PinOrb.tsx";
import { controlClass } from "../ui/primitives.tsx";

const inputCls = cn(controlClass, "h-12 px-4 text-body rounded-xl");

/**
 * Sign in with your Proxmox account. The password goes to this device's host service, which checks it with Proxmox's
 * own login, so the same users, realms and two-factor settings apply here as in Proxmox.
 */
export function SignIn({ onSignedIn }: { onSignedIn: (u: LiveUser) => void }) {
  const [realms, setRealms] = useState<Realm[]>([]);
  const [realm, setRealm] = useState("pam");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.realms().then((r) => {
      setRealms(r);
      const d = r.find((x) => x.default) ?? r.find((x) => x.realm === "pam") ?? r[0];
      if (d) setRealm(d.realm);
    }, () => setRealms([]));
  }, []);

  const finish = async () => onSignedIn(await api.me());

  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.login(username.trim(), password, realm);
      setPassword("");
      if ("needTfa" in r) setChallenge(r.challenge);
      else await finish();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.tfa(challenge!, code.trim(), recovery ? "recovery" : "totp");
      await finish();
    } catch (err) {
      if (err instanceof ApiError && err.code === "tfa_expired") {
        setChallenge(null);
        setCode("");
      }
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh relative flex flex-col items-center px-5">
      <div className="absolute inset-0 hero-glow opacity-60 pointer-events-none" aria-hidden />
      <main className="relative w-full max-w-[400px] pt-[14vh] pb-16 fade-in">
        <div className="flex justify-center mb-8"><PinOrb size={56} /></div>
        <h1 className="text-display font-semibold tracking-tight text-center">{challenge ? "Two-step sign-in" : "Sign in to ePaperclip"}</h1>
        <p className="text-center text-ink-2 mt-3 text-body">
          {challenge ? (recovery ? "Enter one of your recovery keys." : "Enter the code from your authenticator app.") : "Use your Proxmox account. It's the same login, users and permissions."}
        </p>

        {!challenge ? (
          <form onSubmit={submit} className="mt-10 space-y-4">
            <label className="block">
              <span className="block text-sm font-medium mb-2">Username</span>
              <input autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" className={inputCls} />
            </label>
            <label className="block">
              <span className="block text-sm font-medium mb-2">Password</span>
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} />
            </label>
            {realms.length > 1 && (
              <label className="block">
                <span className="block text-sm font-medium mb-2">Realm</span>
                <select value={realm} onChange={(e) => setRealm(e.target.value)} className={cn(inputCls, "appearance-none")}>
                  {realms.map((r) => <option key={r.realm} value={r.realm}>{r.comment ? `${r.comment} (${r.realm})` : r.realm}</option>)}
                </select>
              </label>
            )}
            <FormError text={error} />
            <button type="submit" disabled={busy || !username.trim() || !password} className="h-12 w-full rounded-full bg-primary text-primary-ink font-medium text-body inline-flex items-center justify-center gap-2 disabled:bg-surface-3 disabled:text-ink-3 transition-control active:scale-98">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Sign in <ArrowRight className="h-4 w-4" /></>}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode} className="mt-10 space-y-4">
            <label className="block">
              <span className="block text-sm font-medium mb-2">{recovery ? "Recovery key" : "Code"}</span>
              <input key={String(recovery)} autoFocus autoComplete="one-time-code" inputMode={recovery ? "text" : "numeric"} spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} placeholder={recovery ? "" : "123456"} className={cn(inputCls, !recovery && "tracking-code tabular-nums")} />
            </label>
            <FormError text={error} />
            <button type="submit" disabled={busy || !code.trim()} className="h-12 w-full rounded-full bg-primary text-primary-ink font-medium text-body inline-flex items-center justify-center gap-2 disabled:bg-surface-3 disabled:text-ink-3 transition-control active:scale-98">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Verify <ShieldCheck className="h-4 w-4" /></>}
            </button>
            <div className="flex justify-between text-sm">
              <button type="button" onClick={() => { setRecovery((r) => !r); setCode(""); setError(null); }} className="text-ink-3 hover:text-ink-2 inline-flex items-center gap-1.5"><KeyRound className="h-3.5 w-3.5" />{recovery ? "Use an authenticator code" : "Use a recovery key"}</button>
              <button type="button" onClick={() => { setChallenge(null); setCode(""); setError(null); }} className="text-ink-3 hover:text-ink-2">Start over</button>
            </div>
          </form>
        )}
        <p className="text-xs text-ink-3 text-center mt-10">The stock Proxmox interface stays available on port 8006 as an emergency console.</p>
      </main>
    </div>
  );
}

function FormError({ text }: { text: string | null }) {
  return <p role="alert" className="text-sm text-critical min-h-5">{text}</p>;
}
