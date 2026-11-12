import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, ExternalLink, KeyRound, LogIn } from "lucide-react";
import { connectApi, type LoginView } from "../../data/engine/connectApi.ts";
import { errorText, useAgents } from "../../data/engine/queries.ts";
import { failureCode, signInFailureHelp } from "../../data/engine/signInHelp.ts";
import { httpUrl } from "../../lib/safeUrl.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, EmptyState, Field, Input, Notice, SectionTitle, Select, Spinner, Status } from "../../ui/primitives.tsx";

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
      {signIn && <SignInModal companyId={companyId} orgName={orgName} provider={signIn} knownIds={(ai.data?.connections ?? []).map((c) => c.id).filter((id): id is string => typeof id === "string")} onClose={() => { setSignIn(null); void qc.invalidateQueries({ queryKey: ["connect", "org-ai", companyId] }); }} />}
    </>
  );
}

function SignInModal({ companyId, orgName, provider, knownIds, onClose }: { companyId: string; orgName: string; provider: "anthropic" | "openai"; knownIds: string[]; onClose: () => void }) {
  const label = provider === "anthropic" ? "Claude" : "ChatGPT";
  const [ownership, setOwnership] = useState<"personal" | "shared">("shared");
  const [allAgents, setAllAgents] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const agents = useAgents(companyId);
  const [login, setLogin] = useState<LoginView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const stop = useRef(false);
  const canStart = ownership === "personal" || allAgents || chosen.length > 0;

  const start = useMutation({
    mutationFn: () => connectApi.startLogin(companyId, {
      provider,
      ownership,
      allAgents: ownership === "shared" ? allAgents : false,
      agentIds: ownership === "shared" && !allAgents ? chosen : [],
    }),
    onSuccess: (r) => { setLogin(r.login); setError(null); },
    onError: (e) => { setError(errorText(e)); setErrorCode(failureCode(e)); },
  });
  useEffect(() => {
    if (!login || login.done || login.failed) return;
    stop.current = false;
    const t = setInterval(() => {
      connectApi.pollLogin(companyId, login.id).then((r) => { if (!stop.current) setLogin(r.login); }, (e) => {
        if (stop.current) return;
        // The host forgets a sign-in once it has finished, so the poll after the last step can answer "not found" even
        // though it worked. Look at the accounts before calling it a failure.
        connectApi.orgAi(companyId).then((r) => {
          if (stop.current) return;
          if (r.connections.some((c) => typeof c.id === "string" && !knownIds.includes(c.id))) setLogin((l) => (l ? { ...l, done: true, failed: false } : l));
          else { setError(errorText(e)); setLogin(null); }
        }, () => { if (!stop.current) { setError(errorText(e)); setLogin(null); } });
      });
    }, 2500);
    return () => { stop.current = true; clearInterval(t); };
  }, [login?.id, login?.done, login?.failed, companyId, knownIds]);
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
  const signinAt = httpUrl(login?.verificationUrl);
  return (
    <Modal size="md" icon={<LogIn className="h-5 w-5" />} title={`Sign in with ${label}`} subtitle="The sign-in runs inside the agent container, not on this device." onClose={cancel}
      footer={login?.done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="ghost" onClick={cancel}>Cancel</Button>{!login && <Button variant="primary" loading={start.isPending} disabled={!canStart} onClick={() => start.mutate()}>Start sign-in</Button>}</>}>
      <div className="space-y-4">
        {!login && (
          <div className="space-y-4">
            <Field label="Who can use it" hint="A personal account comes with you. A shared account belongs to the organization, and only an owner or admin can share it.">
              <Select value={ownership} onChange={(e) => setOwnership(e.target.value as "personal" | "shared")}>
                <option value="personal">Only me — comes with me</option>
                <option value="shared">Everyone in {orgName}</option>
              </Select>
            </Field>
            {ownership === "shared" && (
              <div className="space-y-2 rounded-lg border border-line p-3">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allAgents} onChange={(e) => setAllAgents(e.target.checked)} /> All agents</label>
                {!allAgents && (
                  <div className="max-h-40 divide-y divide-line overflow-auto rounded border border-line">
                    {agents.isPending && <p className="px-3 py-2 text-sm text-ink-3">Loading agents…</p>}
                    {agents.error && <p className="px-3 py-2 text-sm text-critical">{errorText(agents.error)}</p>}
                    {(agents.data ?? []).map((a) => (
                      <label key={a.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                        <input type="checkbox" checked={chosen.includes(a.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, a.id] : chosen.filter((id) => id !== a.id))} />
                        <span className="truncate">{a.name}</span>
                      </label>
                    ))}
                    {agents.data && agents.data.length === 0 && <p className="px-3 py-2 text-sm text-ink-3">No agents yet. Share with all agents instead.</p>}
                  </div>
                )}
                {!allAgents && chosen.length === 0 && <p className="text-xs text-ink-3">Pick at least one agent.</p>}
              </div>
            )}
            <p className="text-compact text-ink-2">You'll get a web address and, for some sign-ins, a short code. Open the address in your own browser, sign in to {label}, and approve. This page notices when it's done. Nothing about your password or login is shown here.</p>
          </div>
        )}
        {login && !login.done && !login.failed && (
          <div className="space-y-3" aria-live="polite">
            {!signinAt && <div className="flex items-center gap-2 text-sm text-ink-2"><Spinner label="Waiting for the container" />Starting the sign-in in the container. This takes about 20 seconds the first time.</div>}
            {signinAt && <div><div className="text-compact font-medium mb-1">1. Open this address</div><a href={signinAt} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-accent break-all text-sm">{new URL(signinAt).host}<ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden /></a></div>}
            {login.userCode && <div><div className="text-compact font-medium mb-1">2. Enter this code</div><div className="font-mono text-title tracking-code select-all">{login.userCode}</div></div>}
            {login.needsCode && (
              <Field label={`${login.userCode ? 3 : 2}. Paste the code the browser shows`} hint="Sent to the container to finish; never stored or shown again.">
                <div className="flex gap-2"><Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" /><Button loading={sendCode.isPending} disabled={!code.trim()} onClick={() => sendCode.mutate()}>Send</Button></div>
              </Field>
            )}
            {signinAt && !login.needsCode && <div className="flex items-center gap-2 text-sm text-ink-2"><Spinner label="Waiting for you" />Waiting for you to finish in the browser…</div>}
            {login.message && <p className="text-xs text-ink-3">{login.message}</p>}
          </div>
        )}
        {login?.done && <Notice tone="good" title="Signed in">{ownership === "personal" ? `${label} is connected to your account in ${orgName}. Your runs use it by default.` : `${label} is connected for ${orgName}. ${allAgents ? "All agents" : "The agents you chose"} can use it from their next run.`}</Notice>}
        {login?.failed && <Notice tone="critical" title="The sign-in didn't finish">{login.message ?? `It ended as ${login.status}.`} You can start again.</Notice>}
        {error && <Notice tone="critical" title="The sign-in couldn't start"><p>{error}</p><p className="mt-1.5 text-ink-3">{signInFailureHelp(error, errorCode)} Choose Start sign-in to try again.</p></Notice>}
      </div>
    </Modal>
  );
}
