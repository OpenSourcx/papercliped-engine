import { useState } from "react";
import { Check, Copy, Plug, ShieldAlert, Trash2 } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { Modal } from "../ui/Modal.tsx";
import type { AppMode, AppSession } from "../data/types.ts";
import { cn } from "../lib/storage.ts";
import { Avatar, Button, Card, Chip, EmptyState, PageHeader, SectionTitle, Segmented, Status, PageFrame } from "../ui/primitives.tsx";

const LEVEL = { read: "Read only", control: "Full control" } as const;
const MODE_TEXT: Record<AppMode, string> = {
  api: "Apps can read everything and use the API directly, but can't hand work to agents.",
  full: "Apps can read everything, use the API, and hand work to agents.",
  agent: "Apps can read everything and hand work to agents, but can't change settings through the API.",
};
const HOW: Record<string, string[]> = {
  Claude: ["In Claude, open Settings → Connectors → Add custom connector.", "Paste this device's address and approve the sign-in on your device.", "Pick Read only or Full control."],
  ChatGPT: ["In ChatGPT, open Settings → Apps → Create (developer mode).", "Paste this device's address and approve the sign-in.", "Pick Read only or Full control."],
  Codex: ["Run: codex mcp add epaperclip --url <address>", "Approve the sign-in in your browser.", "Pick Read only or Full control."],
  Other: ["Add a remote MCP server in your app with this address.", "It signs in with OAuth, like the apps above.", "Pick Read only or Full control."],
};

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

function SessionPanel({ session, onClose }: { session: AppSession; onClose: () => void }) {
  const { data, updateSession, revokeSession } = useEngine();
  const owner = data.users.find((u) => u.id === session.userId);
  const reachable = data.orgs.filter((o) => owner?.role === "owner" || owner?.orgs.some((x) => x.slug === o.slug));
  const agents = reachable.filter((o) => session.orgs === null || session.orgs.includes(o.slug)).flatMap((o) => o.agents.map((a) => ({ ...a, org: o.name })));
  const toggle = (list: string[] | null, all: string[], v: string): string[] | null => {
    const cur = list ?? all;
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    return next.length === all.length ? null : next;
  };
  return (
    <Modal title={session.app} subtitle={`${session.client} · approved by ${owner?.name ?? "unknown"}`} icon={<Avatar name={session.app} hue={session.app === "Claude" ? 30 : session.app === "ChatGPT" ? 160 : 260} size={40} />} onClose={onClose}>
      <div className="space-y-6">
          <div>
            <div className="text-[13px] font-medium mb-2">Access level</div>
            <Segmented value={session.level} onChange={(level) => updateSession(session.id, { level })} options={[{ value: "read", label: "Read only" }, { value: "control", label: "Full control" }]} />
            <p className="text-[12px] text-ink-3 mt-2">Never more than {owner?.name ?? "its owner"} can do in Access control, whatever is set here.</p>
          </div>
          <div>
            <div className="text-[13px] font-medium mb-2">Organizations</div>
            <div className="space-y-2">
              {reachable.map((o) => {
                const on = session.orgs === null || session.orgs.includes(o.slug);
                return (
                  <button key={o.slug} onClick={() => updateSession(session.id, { orgs: toggle(session.orgs, reachable.map((x) => x.slug), o.slug) })} className="w-full flex items-center gap-3 text-left" role="checkbox" aria-checked={on}>
                    <span className={cn("h-5 w-5 rounded-md border flex items-center justify-center", on ? "bg-accent border-accent text-primary-ink" : "border-line-strong")}>{on && <Check className="h-3.5 w-3.5" strokeWidth={3} />}</span>
                    <Avatar name={o.name} hue={o.hue} size={22} />
                    <span className="text-[14px]">{o.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="text-[13px] font-medium mb-2">Agents</div>
            {agents.length === 0 ? <p className="text-[13px] text-ink-3">No agents in the selected organizations.</p> : (
              <div className="space-y-2">
                {agents.map((a) => {
                  const on = session.agents === null || session.agents.includes(a.id);
                  return (
                    <button key={a.id} onClick={() => updateSession(session.id, { agents: toggle(session.agents, agents.map((x) => x.id), a.id) })} className="w-full flex items-center gap-3 text-left" role="checkbox" aria-checked={on}>
                      <span className={cn("h-5 w-5 rounded-md border flex items-center justify-center", on ? "bg-accent border-accent text-primary-ink" : "border-line-strong")}>{on && <Check className="h-3.5 w-3.5" strokeWidth={3} />}</span>
                      <span className="text-[14px] flex-1">{a.name} <span className="text-ink-3">· {a.role}</span></span>
                      <span className="text-[12px] text-ink-3">{a.org}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <Button variant="danger" onClick={() => { revokeSession(session.id); onClose(); }}><Trash2 className="h-4 w-4" />Disconnect {session.app}</Button>
      </div>
    </Modal>
  );
}

export function Apps() {
  const { data, host, setAppMode } = useEngine();
  const [how, setHow] = useState("Claude");
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const url = `https://${host.ip}/mcp`;
  const session = data.apps.sessions.find((s) => s.id === open);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard blocked; the address stays visible to copy by hand
    }
  };

  return (
    <PageFrame width="6xl">
      <PageHeader title="Connected apps" subtitle="Papercliped is built in. Connect Claude, ChatGPT, Codex or any MCP app straight to this device, and control what each one can do." />

      <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-4">
        <Card className="p-5">
          <SectionTitle>Connect an app</SectionTitle>
          <div className="flex items-center gap-2 rounded-xl bg-surface-2 border border-line pl-4 pr-1.5 h-12">
            <Plug className="h-4 w-4 text-ink-3 shrink-0" />
            <code className="flex-1 min-w-0 truncate text-[14px]">{url}</code>
            <Button size="sm" onClick={copy}>{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? "Copied" : "Copy"}</Button>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-4">
            {Object.keys(HOW).map((k) => (
              <button key={k} onClick={() => setHow(k)} className={cn("h-7 px-3 rounded-full text-[13px] border", how === k ? "bg-surface-3 border-line-strong text-ink" : "border-line text-ink-3 hover:text-ink-2")}>{k}</button>
            ))}
          </div>
          <ol className="mt-3 space-y-1.5 text-[14px] text-ink-2 list-decimal pl-5">
            {HOW[how].map((step) => <li key={step}>{step.replace("<address>", url)}</li>)}
          </ol>
          <p className="text-[12px] text-ink-3 mt-3">Apps on the web, like claude.ai, need to reach this device from the internet. Turn on remote access (Tailscale or a tunnel) in Connectors first.</p>
        </Card>
        <Card className="p-5">
          <SectionTitle>What apps can do</SectionTitle>
          <Segmented value={data.apps.mode} onChange={setAppMode} options={[{ value: "api", label: "API only" }, { value: "full", label: "Full" }, { value: "agent", label: "Agent only" }]} />
          <p className="text-[14px] text-ink-2 mt-3">{MODE_TEXT[data.apps.mode]}</p>
          <div className="mt-4 pt-4 border-t border-line text-[13px] text-ink-3 space-y-1.5">
            <p><span className="text-ink-2">Read only</span> sessions can only look. <span className="text-ink-2">Full control</span> sessions can act, within this setting.</p>
            <p className="flex gap-1.5"><ShieldAlert className="h-4 w-4 shrink-0 mt-px" />Every session belongs to a user in Access control and can never do more than that user.</p>
          </div>
        </Card>
      </div>

      <section className="mt-8">
        <SectionTitle>Sessions</SectionTitle>
        {data.apps.sessions.length === 0 ? (
          <Card><EmptyState icon={<Plug className="h-5 w-5" />} title="No apps connected" body="Copy this device's address into Claude, ChatGPT or Codex to connect one." /></Card>
        ) : (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {data.apps.sessions.map((s) => {
              const owner = data.users.find((u) => u.id === s.userId);
              const orgNames = s.orgs === null ? "All organizations" : s.orgs.map((slug) => data.orgs.find((o) => o.slug === slug)?.name ?? slug).join(", ") || "No organizations";
              return (
                <button key={s.id} onClick={() => setOpen(s.id)} className="text-left">
                  <Card interactive className="p-4 h-full">
                    <div className="flex items-start gap-3">
                      <Avatar name={s.app} hue={s.app === "Claude" ? 30 : s.app === "ChatGPT" ? 160 : 260} size={36} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2"><span className="font-semibold">{s.app}</span><Chip tone={s.level === "control" ? "accent" : "neutral"}>{LEVEL[s.level]}</Chip></div>
                        <div className="text-[12px] text-ink-3 truncate">{s.client} · {owner?.name ?? "unknown user"}</div>
                      </div>
                    </div>
                    <div className="mt-3 space-y-1 text-[13px] text-ink-2">
                      <div className="truncate">{orgNames}</div>
                      <div>{s.agents === null ? "All agents" : `${s.agents.length} selected agent${s.agents.length === 1 ? "" : "s"}`}</div>
                    </div>
                    <div className="mt-3 pt-3 border-t border-line flex justify-between text-[12px] text-ink-3 tabular-nums"><span>Used {ago(s.lastUsedAt)}</span><span>{s.calls24h} calls today</span></div>
                  </Card>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-8">
        <SectionTitle>Activity</SectionTitle>
        <Card className="divide-y divide-line">
          {data.apps.activity.map((a) => {
            const s = data.apps.sessions.find((x) => x.id === a.sessionId);
            return (
              <div key={a.id} className="flex items-center gap-3 px-5 py-3 text-[14px]">
                <span className="w-24 shrink-0 text-ink-2">{s?.app ?? "Disconnected"}</span>
                <code className="flex-1 truncate text-[13px] text-ink-2">{a.tool}</code>
                {a.outcome === "ok" ? <Status kind="good" label="Done" /> : a.outcome === "blocked" ? <Status kind="warning" label="Blocked" /> : <Status kind="critical" label="Error" />}
                <span className="w-20 text-right text-[12px] text-ink-3 tabular-nums">{ago(a.at)}</span>
              </div>
            );
          })}
        </Card>
        <p className="text-[12px] text-ink-3 mt-2">Activity lists which tool ran and how it ended, never the arguments or results.</p>
      </section>
      {session && <SessionPanel session={session} onClose={() => setOpen(null)} />}
    </PageFrame>
  );
}
