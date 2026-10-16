import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, ExternalLink, KeyRound, LogIn } from "lucide-react";
import { connectApi, type LoginView } from "../../data/engine/connectApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { httpUrl } from "../../lib/safeUrl.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, EmptyState, Field, Input, Notice, SectionTitle, Spinner, Status } from "../../ui/primitives.tsx";

/**
 * An organization's AI accounts for its agents (docs/CONNECTORS.md): the accounts the engine already holds, signing in
 * with a Claude or ChatGPT subscription (the login runs inside the organization's agent container, never on this
 * device, and the credential goes into the engine's vault and is never shown), and handing over a key from Connectors.
 */
export function AgentAccounts({ companyId, orgName }: { companyId: string; orgName: string }) {
  const qc = useQueryClient();
  const ai = useQuery({ queryKey: ["connect", "org-ai", companyId], queryFn: () => connectApi.orgAi(companyId), retry: 1 });
  const conns = useQuery({ queryKey: ["connect", "connections"], queryFn: connectApi.connections, retry: 1 });
  const [signIn, setSignIn] = useState<"anthropic" | "openai" | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const apply = useMutation({
    mutationFn: (id: string) => connectApi.applyToOrg(companyId, id),
    onSuccess: () => { setNote({ ok: true, text: "Handed to the engine. The key was passed on and is not shown." }); void qc.invalidateQueries({ queryKey: ["connect", "org-ai", companyId] }); },
    onError: (e) => setNote({ ok: false, text: errorText(e) }),
  });
  const shared = (conns.data?.connections ?? []).filter((c) => c.orgs.includes(companyId) && c.configured && c.enabled);
  return (
    <>
      <SectionTitle>AI accounts for {orgName}'s agents</SectionTitle>
      <Card className="divide-y divide-line">
        {ai.isPending && <p className="px-5 py-4 text-sm text-ink-3">Loading…</p>}
        {ai.error && <p role="alert" className="px-5 py-4 text-sm text-ink-2">{errorText(ai.error)}</p>}
        {ai.data && ai.data.connections.length === 0 && <EmptyState icon={<Bot className="h-5 w-5" />} title="No AI account yet" body="Sign in with a subscription below, or hand over a key from Connectors. Agents use these when they run." />}
        {(ai.data?.connections ?? []).map((c, i) => (
          <div key={c.id ?? i} className="flex items-center gap-3 px-5 py-3.5">
            <span className="flex-1 text-sm"><span className="font-medium">{c.name ?? c.provider}</span><span className="text-ink-3"> · {c.provider} · {c.method === "subscription" ? "subscription" : "API key"}{c.ownership ? ` · ${c.ownership}` : ""}</span></span>
            {c.status === "connected" || c.status === "active" ? <Status kind="good" label="Connected" /> : <Status kind="idle" label={c.status ?? "Saved"} />}
          </div>
        ))}
      </Card>

      <div className="mt-6 grid md:grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-1"><LogIn className="h-4 w-4 text-ink-3" aria-hidden /><h3 className="text-sm font-semibold">Sign in with a subscription</h3></div>
          <p className="text-compact text-ink-2 mb-3">For people who pay for Claude or ChatGPT instead of using an API key. The sign-in runs inside {orgName}'s agent container; you finish it in your own browser. The login is saved in the engine's vault and never shown here.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setSignIn("anthropic")}>Claude subscription</Button>
            <Button onClick={() => setSignIn("openai")}>ChatGPT subscription (Codex)</Button>
          </div>
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-1"><KeyRound className="h-4 w-4 text-ink-3" aria-hidden /><h3 className="text-sm font-semibold">Use a key from Connectors</h3></div>
          {conns.data && shared.length === 0 && <p className="text-compact text-ink-2">No connection is shared with {orgName} yet. An administrator can share one in Settings, Connectors.</p>}
          <div className="space-y-2">
            {shared.map((c) => (
              <div key={c.id} className="flex items-center gap-3">
                <span className="flex-1 text-sm">{c.label}</span>
                <Button size="sm" loading={apply.isPending && apply.variables === c.id} disabled={!c.entry.engine} onClick={() => apply.mutate(c.id)}>{c.entry.engine ? "Give to agents" : "Not for agents"}</Button>
              </div>
            ))}
          </div>
          {note && <p role="status" className={`text-compact mt-3 ${note.ok ? "text-good" : "text-critical"}`}>{note.text}</p>}
          <p className="text-xs text-ink-3 mt-3">Only the organization's owners and admins can do this. The engine accepts Anthropic, OpenAI, OpenRouter and xAI keys for agents.</p>
        </Card>
      </div>
      {signIn && <SignInModal companyId={companyId} provider={signIn} onClose={() => { setSignIn(null); void qc.invalidateQueries({ queryKey: ["connect", "org-ai", companyId] }); }} />}
    </>
  );
}

function SignInModal({ companyId, provider, onClose }: { companyId: string; provider: "anthropic" | "openai"; onClose: () => void }) {
  const label = provider === "anthropic" ? "Claude" : "ChatGPT (Codex)";
  const [login, setLogin] = useState<LoginView | null>(null);
  const [flow, setFlow] = useState<"device" | "setup-token">("device");
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const stop = useRef(false);

  const start = useMutation({
    mutationFn: () => connectApi.startLogin(companyId, { provider, flow }),
    onSuccess: (r) => { setLogin(r.login); setError(null); },
    onError: (e) => setError(errorText(e)),
  });
  useEffect(() => {
    if (!login || login.done || login.failed) return;
    stop.current = false;
    const t = setInterval(() => {
      connectApi.pollLogin(companyId, login.id).then((r) => { if (!stop.current) setLogin(r.login); }, (e) => { if (!stop.current) { setError(errorText(e)); setLogin(null); } });
    }, 2500);
    return () => { stop.current = true; clearInterval(t); };
  }, [login?.id, login?.done, login?.failed, companyId]);
  const sendCode = useMutation({
    mutationFn: () => connectApi.sendLoginCode(companyId, login!.id, code.trim()),
    onSuccess: (r) => { setLogin(r.login); setCode(""); },
    onError: (e) => setError(errorText(e)),
    onSettled: () => setCode(""),
  });
  const cancel = () => {
    if (login && !login.done) void connectApi.cancelLogin(companyId, login.id).catch(() => undefined);
    onClose();
  };
  const link = httpUrl(login?.verificationUrl);
  return (
    <Modal size="md" icon={<LogIn className="h-5 w-5" />} title={`Sign in with ${label}`} subtitle="The sign-in runs inside the agent container, not on this device." onClose={cancel}
      footer={login?.done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="ghost" onClick={cancel}>Cancel</Button>{!login && <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>Start sign-in</Button>}</>}>
      <div className="space-y-4">
        {!login && provider === "anthropic" && (
          <Field label="Method">
            <div className="flex gap-2">
              <Button size="sm" variant={flow === "device" ? "primary" : "secondary"} onClick={() => setFlow("device")}>Device sign-in</Button>
              <Button size="sm" variant={flow === "setup-token" ? "primary" : "secondary"} onClick={() => setFlow("setup-token")}>Setup token</Button>
            </div>
          </Field>
        )}
        {!login && <p className="text-compact text-ink-2">You'll get a web address and, for some sign-ins, a short code. Open the address in your own browser, sign in to {label}, and approve. This page notices when it's done. Nothing about your password or login is shown here.</p>}
        {login && !login.done && !login.failed && (
          <div className="space-y-3" aria-live="polite">
            {!link && <div className="flex items-center gap-2 text-sm text-ink-2"><Spinner label="Waiting for the container" />Starting the sign-in in the container…</div>}
            {link && <div><div className="text-compact font-medium mb-1">1. Open this address</div><a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-accent break-all text-sm">{new URL(link).host}<ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden /></a></div>}
            {login.userCode && <div><div className="text-compact font-medium mb-1">2. Enter this code</div><div className="font-mono text-title tracking-code select-all">{login.userCode}</div></div>}
            {login.needsCode && (
              <Field label="3. Paste the code the browser shows" hint="Sent to the container to finish; never stored or shown again.">
                <div className="flex gap-2"><Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" /><Button loading={sendCode.isPending} disabled={!code.trim()} onClick={() => sendCode.mutate()}>Send</Button></div>
              </Field>
            )}
            {link && !login.needsCode && <div className="flex items-center gap-2 text-sm text-ink-2"><Spinner label="Waiting for you" />Waiting for you to finish in the browser…</div>}
            {login.message && <p className="text-xs text-ink-3">{login.message}</p>}
          </div>
        )}
        {login?.done && <Notice tone="good" title="Signed in">{label} is connected. The agents can use it from their next run.</Notice>}
        {login?.failed && <Notice tone="critical" title="The sign-in didn't finish">{login.message ?? `It ended as ${login.status}.`} You can start again.</Notice>}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
