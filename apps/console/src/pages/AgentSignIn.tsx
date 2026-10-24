import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, KeyRound, LogIn } from "lucide-react";
import { LOGIN_ADAPTERS, type LoginAdapter, type LoginSession } from "@papercliped-engine/engine-client";
import { useEngine } from "../data/store.tsx";
import { engine, errorText, useAgentContainers, useOrgs } from "../data/engine/queries.ts";
import { Modal } from "../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Field, Input, Notice, PageFrame, PageHeader, Spinner } from "../ui/primitives.tsx";

/**
 * Settings → Agent sign-in: lets an organization's agents use a person's own Claude, Codex or Grok account instead of an API
 * key. The sign-in runs in the organization's agent container (the only place agents run): the console opens the
 * provider's page in a new tab, the person approves there, and the engine keeps the credential as a secret. Gemini has
 * no account sign-in in Paperclip, so it uses an API key (Vault, shared with the agents that need it).
 * See docs/AGENT-AUTH.md.
 */

export const HARNESSES: { adapter: LoginAdapter | "gemini_local"; name: string; login: boolean; how: string }[] = [
  { adapter: "claude_local", name: "Claude Code", login: true, how: "Sign in with your Claude account, then paste the code Claude shows you." },
  { adapter: "codex_local", name: "Codex", login: true, how: "Sign in with your ChatGPT account: open the page and enter the code shown here." },
  { adapter: "grok_local", name: "Grok", login: true, how: "Sign in with your Grok account: open the page and enter the code shown here." },
  { adapter: "gemini_local", name: "Gemini CLI", login: false, how: "Gemini has no account sign-in for agents. Add a GEMINI_API_KEY in the Vault and share it with the agents that use Gemini." },
];

export function AgentSignIn() {
  return useEngine().live ? <LiveSignIn /> : (
    <PageFrame width="4xl">
      <PageHeader title="Agent sign-in" subtitle="Let agents use your own AI account." />
      <Notice>Signing in runs in an organization's agent container on the device, so it isn't part of the demo.</Notice>
    </PageFrame>
  );
}

function LiveSignIn() {
  const orgs = useOrgs();
  const containers = useAgentContainers();
  const [flow, setFlow] = useState<{ companyId: string; org: string; adapter: LoginAdapter; environmentId: string } | null>(null);
  const envs = containers.data?.environments ?? [];
  return (
    <PageFrame width="4xl">
      <PageHeader title="Agent sign-in" subtitle="Let an organization's agents use your own Claude, Codex or Grok account, or use an API key instead. The sign-in happens in that organization's agent container; the engine keeps the result as a secret and never shows it." />
      {orgs.isPending && <div className="py-10 flex justify-center"><Spinner /></div>}
      {orgs.error && <p role="alert" className="text-compact text-critical mb-3">{errorText(orgs.error)}</p>}
      {containers.data && containers.data.state !== "ready" && (
        <Notice tone="warning" title="Agent containers aren't set up yet" className="mb-4">Agents run in containers, and a sign-in runs in one too. Set them up first in Settings → Agent containers.</Notice>
      )}
      {orgs.data?.length === 0 && <EmptyState icon={<LogIn className="h-5 w-5" />} title="No organizations yet" body="Create an organization first; sign-ins belong to one." />}
      <div className="space-y-4">
        {(orgs.data ?? []).filter((c) => c.status !== "archived").map((c) => {
          const environmentId = envs.find((e) => e.companyId === c.id && e.ok)?.environmentId ?? null;
          return (
            <Card key={c.id} className="p-5">
              <h3 className="text-body font-medium mb-3">{c.name}</h3>
              <div className="divide-y divide-line">
                {HARNESSES.map((h) => (
                  <HarnessRow key={h.adapter} companyId={c.id} h={h} environmentId={environmentId} onSignIn={(adapter) => environmentId && setFlow({ companyId: c.id, org: c.name, adapter, environmentId })} />
                ))}
              </div>
            </Card>
          );
        })}
      </div>
      <p className="text-xs text-ink-3 mt-4 flex items-center gap-1.5"><KeyRound className="h-3.5 w-3.5" aria-hidden />Prefer an API key? Add it in Settings → Vault and share it with the agents that should use it; an API key always wins over a signed-in account.</p>
      {flow && <SignInModal {...flow} onClose={() => setFlow(null)} />}
    </PageFrame>
  );
}

function HarnessRow({ companyId, h, environmentId, onSignIn }: { companyId: string; h: (typeof HARNESSES)[number]; environmentId: string | null; onSignIn: (a: LoginAdapter) => void }) {
  const adapter = h.adapter === "gemini_local" ? null : h.adapter;
  // Claude and Codex can say whether an account is already signed in; for the others the engine answers "unknown".
  const signal = useQuery({ queryKey: ["agent-auth", companyId, h.adapter, environmentId], enabled: !!adapter && !!environmentId, retry: false, queryFn: () => engine.agentAuth.signal(companyId, adapter!, environmentId ?? undefined) });
  const signed = signal.data?.status === "authenticated";
  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex items-center gap-2 font-medium text-compact">{h.name}{signed && <Chip tone="good">Signed in</Chip>}</div>
        <p className="text-compact text-ink-3 mt-0.5 text-pretty">{h.how}</p>
      </div>
      {adapter && <Button size="sm" disabled={!environmentId} title={environmentId ? undefined : "This organization has no agent container yet"} onClick={() => onSignIn(adapter)}>{signed ? "Sign in again" : "Sign in"}</Button>}
    </div>
  );
}

const SPIN_MS = 2000;

/** One sign-in, start to finish. Closing it before the end cancels the session so the next try isn't blocked by a stale one. */
export function SignInModal({ companyId, org, adapter, environmentId, onClose }: { companyId: string; org: string; adapter: LoginAdapter; environmentId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const name = HARNESSES.find((h) => h.adapter === adapter)!.name;
  const claude = adapter === "claude_local";
  const [session, setSession] = useState<LoginSession | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [done, setDone] = useState(false);
  const live = useRef<{ id: string | null; over: boolean }>({ id: null, over: false });

  // Start once, then poll the session until it ends.
  useEffect(() => {
    let stopped = false;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      try {
        const s = await engine.agentAuth.start(companyId, adapter, environmentId);
        live.current.id = s.sessionId;
        setSession(s);
        while (!stopped) {
          await sleep(SPIN_MS);
          const cur = await engine.agentAuth.read(companyId, adapter, s.sessionId);
          if (stopped) return;
          setSession((prev) => ({ ...prev, ...cur }));
          if (claude && !address) engine.agentAuth.claudeAddress(companyId, s.sessionId).then((a) => setAddress(a.authorizationUrl)).catch(() => undefined);
          if (cur.status === "authenticated") {
            if (claude) await engine.agentAuth.claudeComplete(companyId, s.sessionId);
            live.current.over = true;
            setDone(true);
            void qc.invalidateQueries({ queryKey: ["agent-auth", companyId] });
            return;
          }
          if (cur.status === "failed" || cur.status === "timed_out" || cur.status === "cancelled") { live.current.over = true; return; }
        }
      } catch (e) {
        if (!stopped) setError(errorText(e));
      }
    })();
    return () => {
      stopped = true;
      const { id, over } = live.current;
      if (id && !over) void engine.agentAuth.cancel(companyId, adapter, id).catch(() => undefined);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const prompt = claude ? (address ? { url: address, code: "" } : null) : session?.prompt ?? null;
  const ended = session?.status === "failed" || session?.status === "timed_out" || session?.status === "cancelled";
  const submit = async () => {
    if (!session) return;
    setError(null);
    try {
      await engine.agentAuth.claudeCode(companyId, session.sessionId, code.trim());
      setSubmitted(true);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const open = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
  return (
    <Modal title={`Sign in to ${name}`} subtitle={`For the agents in ${org}.`} icon={<LogIn className="h-5 w-5" />} onClose={onClose} size="sm"
      footer={<Button variant={done ? "primary" : "ghost"} onClick={onClose}>{done ? "Done" : "Cancel"}</Button>}>
      <div className="space-y-4" aria-live="polite">
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
        {done && <Notice tone="good" title="Signed in">{org}'s agents can use this {name} account. It's kept as a secret; nobody can read it back.</Notice>}
        {ended && <Notice tone="critical" title={session?.status === "timed_out" ? "That took too long" : "The sign-in didn't finish"}>{session?.failure?.message ?? "Close this and try again."}</Notice>}
        {!done && !ended && !error && !prompt && <p className="text-compact text-ink-2 flex items-center gap-2"><Spinner />Starting a sign-in in the container…</p>}
        {!done && !ended && prompt && (
          <>
            <ol className="list-decimal pl-5 space-y-3 text-compact text-ink-2">
              <li>
                <Button size="sm" onClick={() => open(prompt.url)}><ExternalLink className="h-4 w-4" />Open the {name} sign-in page</Button>
                <p className="text-xs text-ink-3 mt-1.5">It opens in a new tab. Sign in with the account you want agents to use.</p>
              </li>
              {!claude && prompt.code && <li>Enter this code there: <code className="font-mono text-body font-semibold text-ink select-all">{prompt.code}</code></li>}
              {claude && (
                <li>
                  <Field label="Paste the code Claude shows you" htmlFor="claude-code"><Input id="claude-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" /></Field>
                  <Button size="sm" className="mt-2" disabled={!code.trim() || submitted} loading={submitted && !done} onClick={submit}>Submit code</Button>
                </li>
              )}
            </ol>
            <p className="text-xs text-ink-3 flex items-center gap-1.5"><Spinner />{submitted || !claude ? "Waiting for you to finish signing in…" : "Waiting for the code…"}</p>
          </>
        )}
      </div>
    </Modal>
  );
}

// LOGIN_ADAPTERS is re-exported so a test can check the page covers every account harness the client knows.
export { LOGIN_ADAPTERS };
