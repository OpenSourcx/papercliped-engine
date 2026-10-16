import { useEffect, useState } from "react";
import { Check, ShieldAlert, X } from "lucide-react";
import { useSession } from "../../auth/session.tsx";
import { connectApi, type AuthRequestInfo, type Level } from "../../data/engine/connectApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { returnUrl } from "../../lib/safeUrl.ts";
import { cn } from "../../lib/storage.ts";
import { PinOrb } from "../../pin/PinOrb.tsx";
import { Button, Card, Notice, Segmented, Spinner, Toggle } from "../../ui/primitives.tsx";

/**
 * The page an MCP app (Claude, ChatGPT, Codex ...) sends a person to: "Connect X to ePaperclip". The host service checked
 * the app and its return address already; this page shows who is asking, where the person will be sent back to, how far
 * the app may go (Read only or Full control), which organizations it may reach, and whether it may act without a plan to
 * approve. Only this signed-in page can approve; the app never sees a password or a Proxmox token.
 */
export function ConsentPage() {
  const { session } = useSession();
  const query = window.location.search.replace(/^\?/, "");
  const [info, setInfo] = useState<AuthRequestInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>("paperclip:read");
  const [allOrgs, setAllOrgs] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [direct, setDirect] = useState(false);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);

  useEffect(() => {
    if (session.mode !== "live") return;
    connectApi.authRequest(query).then((i) => { setInfo(i); setLevel(i.scope); }, (e) => setError(errorText(e)));
  }, [query, session.mode]);

  const decide = async (approve: boolean) => {
    if (!info) return;
    setBusy(approve ? "allow" : "deny");
    setError(null);
    const q = new URLSearchParams(query);
    const body: Record<string, unknown> = Object.fromEntries(q.entries());
    body.approve = approve;
    if (approve) {
      body.scope = level;
      body.direct = level === "paperclip:control" && direct;
      body.orgs = allOrgs || !info.orgs ? null : picked;
    }
    try {
      const r = await connectApi.consent(body);
      const to = returnUrl(r.redirect, info.client.redirectUri);
      if (!to) throw new Error("The app's return address isn't one this page can send you to.");
      window.location.assign(to);
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  };

  const shell = (children: React.ReactNode) => (
    <main className="min-h-dvh flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">{children}</div>
    </main>
  );

  if (session.mode !== "live")
    return shell(<Card className="p-6"><Notice tone="info" title="Connecting apps needs a device">This is the demo. On a device running ePaperclip, an app's sign-in request lands here.</Notice></Card>);
  if (error && !info)
    return shell(
      <Card className="p-6 space-y-3">
        <div className="flex items-center gap-2 text-critical"><ShieldAlert className="h-5 w-5" aria-hidden /><h1 className="text-lead font-semibold">This request can't be approved</h1></div>
        <p role="alert" className="text-sm text-ink-2">{error}</p>
        <p className="text-compact text-ink-3">Nothing was shared. Go back to the app and start the connection again.</p>
      </Card>,
    );
  if (!info) return shell(<div className="flex justify-center"><Spinner label="Checking the request" /></div>);

  const control = info.scope === "paperclip:control";
  const levelInfo = (l: Level) => info.scopes.find((s) => s.id === l)!;
  return shell(
    <Card className="p-6 space-y-5">
      <div className="flex items-center gap-3">
        <PinOrb size={40} />
        <div>
          <h1 className="text-lead font-semibold leading-tight">Connect {info.client.name} to ePaperclip?</h1>
          <p className="text-compact text-ink-3">Signed in as <span className="font-mono">{info.user}</span></p>
        </div>
      </div>

      <div className="rounded-lg bg-surface-2 border border-line px-4 py-3 text-compact text-ink-2">
        <p>
          <span className="text-ink font-medium">{info.client.name}</span> is asking. After you decide, you'll be sent back to{" "}
          <span className="font-mono text-ink">{info.client.redirectHost}</span>
          {info.client.loopback ? " (an app on this computer)" : info.client.customScheme ? " (an app on this computer, opened by its own address)" : ""}. If you don't recognise that address, choose Deny.
        </p>
        <p className="mt-2 text-xs text-ink-3">Full return address</p>
        <p className="font-mono text-xs text-ink break-all" data-testid="redirect-uri">{info.client.redirectUri}</p>
        {info.client.customScheme && <p className="mt-2 text-xs text-ink-3">An administrator of this device allowed this kind of address. Anything installed on your computer could claim it, so only continue if you started this connection yourself.</p>}
      </div>

      <div>
        <div className="text-compact font-medium mb-2">How far it may go</div>
        {control ? (
          <Segmented value={level} onChange={setLevel} label="Access level" options={[{ value: "paperclip:read", label: "Read only" }, { value: "paperclip:control", label: "Full control" }]} />
        ) : (
          <div className="text-sm font-medium">Read only</div>
        )}
        <p className="text-compact text-ink-2 mt-2">{levelInfo(level).description}</p>
        <p className="text-xs text-ink-3 mt-1">Never more than you can do yourself: Proxmox checks every action against your account.</p>
      </div>

      {info.orgs && info.orgs.length > 0 && (
        <div>
          <div className="text-compact font-medium mb-2">Organizations it may see</div>
          <Segmented value={allOrgs ? "all" : "some"} onChange={(v) => setAllOrgs(v === "all")} label="Organizations" options={[{ value: "all", label: "All of mine" }, { value: "some", label: "Only some" }]} />
          {!allOrgs && (
            <div className="mt-3 space-y-2">
              {info.orgs.map((o) => {
                const on = picked.includes(o.id);
                return (
                  <button key={o.id} type="button" role="checkbox" aria-checked={on} onClick={() => setPicked(on ? picked.filter((x) => x !== o.id) : [...picked, o.id])} className="w-full flex items-center gap-3 text-left">
                    <span className={cn("h-5 w-5 rounded-md border flex items-center justify-center", on ? "bg-accent border-accent text-primary-ink" : "border-line-strong")}>{on && <Check className="h-3.5 w-3.5" strokeWidth={3} />}</span>
                    <span className="text-sm">{o.name}</span>
                  </button>
                );
              })}
              {picked.length === 0 && <p className="text-xs text-ink-3">With none picked, it sees only this host, not your organizations.</p>}
            </div>
          )}
        </div>
      )}

      {level === "paperclip:control" && (
        <div className="flex items-start gap-3">
          <Toggle checked={direct} onChange={setDirect} label="Let it act without asking me" />
          <div>
            <div className="text-sm">Let it act without asking me</div>
            <p className="text-xs text-ink-3">Off (recommended): every change to your machines becomes a plan you approve in the console, step by step. On: only starts and snapshots run at once. Stopping, shutting down, rebooting, deleting and rolling back are still plans that you approve yourself by typing the confirmation phrase here; the app can never type it for you. Machines tagged <span className="font-mono">protected</span> are never touched this way.</p>
          </div>
        </div>
      )}

      <p className="text-xs text-ink-3">The connection lasts up to {info.lifetimeDays} days. You can change or end it any time in Connected apps; everything it does is logged.</p>
      {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" onClick={() => decide(false)} loading={busy === "deny"} disabled={busy !== null}><X className="h-4 w-4" />Deny</Button>
        <Button variant="primary" onClick={() => decide(true)} loading={busy === "allow"} disabled={busy !== null}>Allow {levelInfo(level).label}</Button>
      </div>
    </Card>,
  );
}
