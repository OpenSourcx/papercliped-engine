import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Fingerprint, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { api, ApiError, type LiveUser, type Realm, type TfaMethods } from "../data/api.ts";
import { answerChallenge, webauthnAvailable } from "../pages/access/webauthn.ts";
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
  const [methods, setMethods] = useState<TfaMethods | null>(null);
  const [banner, setBanner] = useState("");
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.realms().then((r) => {
      setRealms(r);
      const d = r.find((x) => x.default) ?? r.find((x) => x.realm === "pam") ?? r[0];
      if (d) setRealm(d.realm);
    }, () => setRealms([]));
  }, []);

  // The login notice (Proxmox's consent text) has to be acknowledged before signing in.
  useEffect(() => {
    void api.banner().then(setBanner);
  }, []);

  // Coming back from an OpenID Connect provider: the address carries ?code=…&state=…
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const code = q.get("code");
    const state = q.get("state");
    if (!code || !state) return;
    window.history.replaceState(null, "", window.location.pathname);
    setBusy(true);
    api.openidFinish(code, state).then(() => api.me()).then(onSignedIn, (err) => {
      setError(err instanceof ApiError ? err.message : "That sign-in didn't work. Try again.");
      setBusy(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openid = async (r: string) => {
    setBusy(true);
    setError(null);
    try {
      window.location.assign((await api.openidStart(r)).url);
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  };

  const useKey = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await answerChallenge(methods!.webauthn!);
      await api.tfaKey(challenge!, answer);
      await finish();
    } catch (err) {
      if (err instanceof ApiError && err.code === "tfa_expired") setChallenge(null);
      setError(err instanceof ApiError ? err.message : err instanceof DOMException && err.name === "NotAllowedError" ? "The key wasn't used in time, or you cancelled. Try again." : "The security key didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => onSignedIn(await api.me());

  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.login(username.trim(), password, realm);
      setPassword("");
      if ("needTfa" in r) {
        setChallenge(r.challenge);
        setMethods(r.methods ?? null);
        setRecovery(false);
      }
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

  const keyOnly = !!methods?.webauthn && !methods.totp && !methods.recovery;
  const canKey = !!methods?.webauthn && webauthnAvailable();
  const openidRealms = realms.filter((r) => r.type === "openid");
  const blocked = banner !== "" && !read;

  return (
    <div className="min-h-dvh relative flex flex-col items-center px-5">
      <div className="absolute inset-0 hero-glow opacity-60 pointer-events-none" aria-hidden />
      <main className="relative w-full max-w-[400px] pt-[14vh] pb-16 fade-in">
        <div className="flex justify-center mb-8"><PinOrb size={56} /></div>
        <h1 className="text-display font-semibold tracking-tight text-center">{challenge ? "Two-step sign-in" : "Sign in to ePaperclip"}</h1>
        <p className="text-center text-ink-2 mt-3 text-body">
          {challenge ? (keyOnly ? "Use your security key." : recovery ? "Enter one of your recovery keys." : "Enter the code from your authenticator app.") : "Use your Proxmox account. It's the same login, users and permissions."}
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
            {banner && (
              <div className="rounded-xl border border-line bg-surface p-3" role="group" aria-label="Notice">
                <p className="text-sm text-ink-2 whitespace-pre-wrap max-h-40 overflow-y-auto overflow-x-hidden">{banner}</p>
                <label className="flex items-center gap-2 text-sm mt-3"><input type="checkbox" className="h-4 w-4 accent-(--accent)" checked={read} onChange={(e) => setRead(e.target.checked)} />I have read this notice</label>
              </div>
            )}
            <FormError text={error} />
            <button type="submit" disabled={busy || blocked || !username.trim() || !password} className="h-12 w-full rounded-full bg-primary text-primary-ink font-medium text-body inline-flex items-center justify-center gap-2 disabled:bg-surface-3 disabled:text-ink-3 transition-control active:scale-98">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Sign in <ArrowRight className="h-4 w-4" /></>}
            </button>
            {openidRealms.length > 0 && (
              <div className="pt-2 space-y-2">
                <div className="text-xs text-ink-3 text-center">or</div>
                {openidRealms.map((r) => (
                  <button key={r.realm} type="button" disabled={busy || blocked} onClick={() => void openid(r.realm)} className="h-12 w-full rounded-full border border-line bg-surface-2 text-body inline-flex items-center justify-center gap-2 disabled:opacity-50 hover:border-line-strong transition-control">
                    <ShieldCheck className="h-4 w-4" />Sign in with {r.comment || r.realm}
                  </button>
                ))}
              </div>
            )}
          </form>
        ) : (
          <form onSubmit={submitCode} className="mt-10 space-y-4">
            {canKey && (
              <button type="button" disabled={busy} onClick={() => void useKey()} className="h-12 w-full rounded-full bg-primary text-primary-ink font-medium text-body inline-flex items-center justify-center gap-2 disabled:bg-surface-3 disabled:text-ink-3 transition-control active:scale-98">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Fingerprint className="h-4 w-4" />Use security key</>}
              </button>
            )}
            {keyOnly && !canKey && <p role="alert" className="text-sm text-critical">This browser can't use security keys on this address. Use a browser that does, or ask an administrator.</p>}
            {!keyOnly && <label className="block">
              <span className="block text-sm font-medium mb-2">{recovery ? "Recovery key" : "Code"}</span>
              <input key={String(recovery)} autoFocus autoComplete="one-time-code" inputMode={recovery ? "text" : "numeric"} spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} placeholder={recovery ? "" : "123456"} className={cn(inputCls, !recovery && "tracking-code tabular-nums")} />
            </label>}
            <FormError text={error} />
            {!keyOnly && <button type="submit" disabled={busy || !code.trim()} className="h-12 w-full rounded-full bg-primary text-primary-ink font-medium text-body inline-flex items-center justify-center gap-2 disabled:bg-surface-3 disabled:text-ink-3 transition-control active:scale-98">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Verify <ShieldCheck className="h-4 w-4" /></>}
            </button>}
            <div className="flex justify-between text-sm">
              {!keyOnly && (!methods || methods.recovery) ? <button type="button" onClick={() => { setRecovery((r) => !r); setCode(""); setError(null); }} className="text-ink-3 hover:text-ink-2 inline-flex items-center gap-1.5"><KeyRound className="h-3.5 w-3.5" />{recovery ? "Use an authenticator code" : "Use a recovery key"}</button> : <span />}
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
