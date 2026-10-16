import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Plug, ShieldAlert, Trash2 } from "lucide-react";
import { connectApi, type ConnectedApp, type Level } from "../../data/engine/connectApi.ts";
import { ago } from "../../data/engine/map.ts";
import { errorText } from "../../data/engine/queries.ts";
import { cn } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Avatar, Button, Card, Chip, EmptyState, Notice, PageFrame, PageHeader, SectionTitle, Segmented, Spinner, Status, Toggle } from "../../ui/primitives.tsx";

const LEVEL: Record<Level, string> = { "paperclip:read": "Read only", "paperclip:control": "Full control" };
const HOW: Record<string, string[]> = {
  Claude: ["In Claude, open Settings, Connectors, then Add custom connector.", "Paste this device's address and approve the sign-in on your device.", "Pick Read only or Full control on the approval page."],
  ChatGPT: ["In ChatGPT, open Settings, Apps, then Create (developer mode).", "Paste this device's address, choose OAuth, and approve the sign-in.", "Pick Read only or Full control on the approval page."],
  Codex: ["Run: codex mcp add epaperclip --url <address>", "Approve the sign-in that opens in your browser.", "Pick Read only or Full control on the approval page."],
  Other: ["Add a remote MCP server in your app with this address.", "It signs in with OAuth (authorization code with PKCE), like the apps above.", "Pick Read only or Full control on the approval page."],
};
const hueOf = (name: string) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/** Live Connected apps: the Papercliped bridge on this device (docs/CONNECTORS.md). */
export function LiveApps() {
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: ["connect", "overview"], queryFn: connectApi.overview, retry: 1 });
  const admin = overview.data?.canManageAll === true;
  const apps = useQuery({ queryKey: ["connect", "apps", admin], queryFn: () => connectApi.apps(admin), enabled: overview.isSuccess, retry: 1 });
  const activity = useQuery({ queryKey: ["connect", "activity", admin], queryFn: () => connectApi.activity(admin), enabled: overview.isSuccess, retry: 1 });
  const [how, setHow] = useState("Claude");
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const url = overview.data?.mcpUrl ?? "";
  const copy = () => {
    void navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined);
  };
  const selected = apps.data?.apps.find((a) => a.id === open) ?? null;
  const refresh = () => qc.invalidateQueries({ queryKey: ["connect"] });

  if (overview.isPending) return <PageFrame width="3xl"><PageHeader title="Connected apps" /><div className="py-10 flex justify-center"><Spinner /></div></PageFrame>;
  if (overview.error)
    return (
      <PageFrame width="3xl">
        <PageHeader title="Connected apps" subtitle="Connect Claude, ChatGPT, Codex or any MCP app to this device." />
        <Card><EmptyState icon={<Plug className="h-5 w-5" />} title="Not available right now" body={errorText(overview.error)} /></Card>
      </PageFrame>
    );

  return (
    <PageFrame width="6xl">
      <PageHeader title="Connected apps" subtitle="Papercliped is built in. Connect Claude, ChatGPT, Codex or any MCP app straight to this device, and control what each one can do." />
      <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-4">
        <Card className="p-5">
          <SectionTitle>Connect an app</SectionTitle>
          <div className="flex items-center gap-2 rounded-xl bg-surface-2 border border-line pl-4 pr-1.5 h-12">
            <Plug className="h-4 w-4 text-ink-3 shrink-0" aria-hidden />
            <code className="flex-1 min-w-0 truncate text-sm">{url}</code>
            <Button size="sm" onClick={copy}>{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? "Copied" : "Copy"}</Button>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-4" role="tablist" aria-label="App">
            {Object.keys(HOW).map((k) => (
              <button key={k} role="tab" aria-selected={how === k} onClick={() => setHow(k)} className={cn("h-7 px-3 rounded-full text-compact border", how === k ? "bg-surface-3 border-line-strong text-ink" : "border-line text-ink-3 hover:text-ink-2")}>{k}</button>
            ))}
          </div>
          <ol className="mt-3 space-y-1.5 text-sm text-ink-2 list-decimal pl-5">{HOW[how].map((step) => <li key={step}>{step.replace("<address>", url)}</li>)}</ol>
          <p className="text-xs text-ink-3 mt-3">Web apps like claude.ai and ChatGPT reach this device over the internet, so it needs an https address they can open (a tunnel or Tailscale). Codex and other programs on your own network can use the address above.</p>
        </Card>
        <Card className="p-5">
          <SectionTitle>What apps can do</SectionTitle>
          {overview.data.scopes.map((s) => (
            <div key={s.id} className="mb-3 last:mb-0"><div className="text-sm font-medium">{s.label}</div><p className="text-compact text-ink-2">{s.description}</p></div>
          ))}
          <div className="mt-4 pt-4 border-t border-line text-compact text-ink-3 space-y-1.5">
            <p className="flex gap-1.5"><ShieldAlert className="h-4 w-4 shrink-0 mt-px" aria-hidden />Every app acts as the person who approved it, through their own Proxmox permissions, and can never do more than that person.</p>
            <p>Connections last up to {overview.data.grantDays} days and can be ended here at any time.</p>
          </div>
        </Card>
      </div>

      <section className="mt-8">
        <SectionTitle>{apps.data?.scope === "all" ? "Connected apps (everyone's)" : "Your connected apps"}</SectionTitle>
        {apps.error && <p role="alert" className="text-compact text-critical mb-2">{errorText(apps.error)}</p>}
        {apps.data && apps.data.apps.length === 0 ? (
          <Card><EmptyState icon={<Plug className="h-5 w-5" />} title="No apps connected" body="Copy this device's address into Claude, ChatGPT or Codex to connect one." /></Card>
        ) : (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {(apps.data?.apps ?? []).map((a) => (
              <button key={a.id} onClick={() => setOpen(a.id)} className="text-left" aria-label={`${a.clientName}, ${LEVEL[a.scope]}`}>
                <Card interactive className="p-4 h-full">
                  <div className="flex items-start gap-3">
                    <Avatar name={a.clientName} hue={hueOf(a.clientName)} size={36} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><span className="font-semibold truncate">{a.clientName}</span><Chip tone={a.scope === "paperclip:control" ? "accent" : "neutral"}>{LEVEL[a.scope]}</Chip></div>
                      <div className="text-xs text-ink-3 truncate">{a.clientHost} · {a.userid}</div>
                    </div>
                  </div>
                  <div className="mt-3 text-compact text-ink-2">{a.orgs === null ? "All organizations" : a.orgs.length ? `${a.orgs.length} organization${a.orgs.length === 1 ? "" : "s"}` : "This host only"}{a.direct ? " · starts and snapshots run at once" : ""}</div>
                  <div className="mt-3 pt-3 border-t border-line flex justify-between text-xs text-ink-3 tabular-nums"><span>{a.lastUsedAt ? `Used ${ago(new Date(a.lastUsedAt))}` : "Not used yet"}</span><span>Ends {new Date(a.expiresAt).toLocaleDateString()}</span></div>
                </Card>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <SectionTitle>Activity</SectionTitle>
        <Card className="divide-y divide-line">
          {(activity.data?.calls ?? []).length === 0 && <p className="px-5 py-4 text-sm text-ink-3">Nothing yet. Each tool an app runs shows here.</p>}
          {(activity.data?.calls ?? []).slice(0, 30).map((c, i) => (
            <div key={`${c.at}-${i}`} className="flex items-center gap-3 px-5 py-3 text-sm">
              <span className="w-24 shrink-0 text-ink-2 truncate">{c.client}</span>
              <code className="flex-1 truncate text-compact text-ink-2">{c.tool}</code>
              {c.control && <Chip>Control</Chip>}
              {c.ok ? <Status kind="good" label="Done" /> : <Status kind="critical" label="Refused" />}
              <span className="w-20 text-right text-xs text-ink-3 tabular-nums">{ago(new Date(c.at))}</span>
            </div>
          ))}
        </Card>
        <p className="text-xs text-ink-3 mt-2">Activity lists which tool ran and how it ended, never the arguments or results. Changes also go in the audit trail.</p>
      </section>

      {admin && (
        <section className="mt-8">
          <SectionTitle>Administrators</SectionTitle>
          <Card className="p-5 flex items-start gap-3">
            <Toggle checked={overview.data.fetchUrl} label="Let Full control apps fetch web pages" onChange={(v) => connectApi.setFetchUrl(v).then(refresh)} />
            <div><div className="text-sm">Let Full control apps fetch web pages</div><p className="text-xs text-ink-3">Adds one tool that reads public https pages from this host. Off by default; it never reaches addresses on your network.</p></div>
          </Card>
        </section>
      )}
      {selected && <AppPanel app={selected} orgs={overview.data.orgs} onClose={() => setOpen(null)} onChanged={refresh} />}
    </PageFrame>
  );
}

function AppPanel({ app, orgs: list, onClose, onChanged }: { app: ConnectedApp; orgs: { id: string; name: string }[]; onClose: () => void; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const patch = useMutation({ mutationFn: (p: Partial<Pick<ConnectedApp, "scope" | "direct" | "orgs">>) => connectApi.updateApp(app.id, p), onSuccess: onChanged, onError: (e) => setError(errorText(e)) });
  const revoke = useMutation({ mutationFn: () => connectApi.revokeApp(app.id), onSuccess: () => { onChanged(); onClose(); }, onError: (e) => setError(errorText(e)) });
  const toggle = (id: string) => {
    const cur = app.orgs ?? list.map((o) => o.id);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    patch.mutate({ orgs: next.length === list.length ? null : next });
  };
  return (
    <Modal title={app.clientName} subtitle={`${app.clientHost} · approved by ${app.userid}`} icon={<Avatar name={app.clientName} hue={hueOf(app.clientName)} size={40} />} onClose={onClose}
      footer={confirmRevoke ? <><Button variant="ghost" onClick={() => setConfirmRevoke(false)}>Keep it</Button><Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate()}><Trash2 className="h-4 w-4" />End the connection</Button></> : <><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="danger" onClick={() => setConfirmRevoke(true)}><Trash2 className="h-4 w-4" />Revoke</Button></>}>
      <div className="space-y-6">
        {confirmRevoke && <Notice tone="warning" title={`End ${app.clientName}'s access now?`}>It stops working at once and its Proxmox token is deleted. You can connect it again later.</Notice>}
        <div>
          <div className="text-compact font-medium mb-2">Access level</div>
          <Segmented value={app.scope} label="Access level" onChange={(scope) => patch.mutate({ scope })} options={[{ value: "paperclip:read", label: "Read only" }, { value: "paperclip:control", label: "Full control" }]} />
          <p className="text-xs text-ink-3 mt-2">Never more than {app.userid} can do in Access control, whatever is set here.</p>
        </div>
        {app.scope === "paperclip:control" && (
          <div className="flex items-start gap-3">
            <Toggle checked={app.direct} label="Act without asking" onChange={(direct) => patch.mutate({ direct })} />
            <div><div className="text-sm">Act without asking</div><p className="text-xs text-ink-3">Off: every host change becomes a plan you approve. On: only starts and snapshots run at once. Stopping, rebooting, deleting and rolling back are always plans you approve yourself with the typed phrase in the console (the app cannot type it), and machines tagged protected are never touched.</p></div>
          </div>
        )}
        {list.length > 0 && (
          <div>
            <div className="text-compact font-medium mb-2">Organizations</div>
            <div className="space-y-2">
              {list.map((o) => {
                const on = app.orgs === null || app.orgs.includes(o.id);
                return (
                  <button key={o.id} type="button" role="checkbox" aria-checked={on} onClick={() => toggle(o.id)} className="w-full flex items-center gap-3 text-left">
                    <span className={cn("h-5 w-5 rounded-md border flex items-center justify-center", on ? "bg-accent border-accent text-primary-ink" : "border-line-strong")}>{on && <Check className="h-3.5 w-3.5" strokeWidth={3} />}</span>
                    <Avatar name={o.name} hue={hueOf(o.name)} size={22} />
                    <span className="text-sm">{o.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}
