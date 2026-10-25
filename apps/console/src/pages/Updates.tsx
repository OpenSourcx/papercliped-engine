import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, CheckCircle2, ChevronLeft, ChevronRight, Download, Loader2, Paperclip, RefreshCw, RotateCcw, Server } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { nodeApi } from "../data/engine/nodeApi.ts";
import { errorMessage, pinRt, type UpdateInfo } from "../data/engine/pinRuntimeApi.ts";
import { proxmoxVersion } from "../lib/version.ts";
import { usePin } from "../pin/PinContext.tsx";
import { ago } from "./pin/runtime.tsx";
import { useNodeName } from "./node/common.tsx";
import { Button, Card, Notice, PageHeader, Status, PageFrame } from "../ui/primitives.tsx";
import { Markdown } from "./pin/notes/Markdown.tsx";
import { RestartNotice, UpdateHistory, UpdateOptions } from "./updates/UpdateOptions.tsx";

/**
 * Updates, in the manner of the system's own update page: one answer first ("You're up to date" or what is waiting), when it
 * last looked, one button to look again, then a row for each thing that can be updated with its short version. Long build
 * strings never reach a headline.
 */

function Row({ icon, name, detail, status, to, action }: { icon: ReactNode; name: string; detail: ReactNode; status: ReactNode; to: string; action: string }) {
  return (
    <Link to={to} className="transition-control group flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 hover:bg-surface-2 first:rounded-t-xl last:rounded-b-xl">
      <span className="h-10 w-10 shrink-0 rounded-lg bg-surface-2 text-ink-2 flex items-center justify-center group-hover:bg-surface-3" aria-hidden>{icon}</span>
      <span className="min-w-0 flex-1 basis-48">
        <span className="block font-medium">{name}</span>
        <span className="block text-compact text-ink-3 break-words">{detail}</span>
      </span>
      <span className="flex items-center gap-3 shrink-0">
        {status}
        <span className="inline-flex items-center gap-0.5 text-compact text-ink-2 group-hover:text-ink">{action}<ChevronRight className="h-4 w-4" aria-hidden /></span>
      </span>
    </Link>
  );
}

const PHASE = { queued: "Queued", downloading: "Downloading", verifying: "Checking the download", installing: "Installing", restarting: "Restarting", done: "Installed", failed: "Didn't finish", rolled_back: "Rolled back" } as const;

function useUpdate() {
  return useQuery({ queryKey: ["pin", "update"], queryFn: pinRt.update, retry: 1, refetchInterval: (q) => (q.state.data?.inProgress ? 3000 : 600_000) });
}

/** What the person is told while a version is being installed: the phase and a bar that fills as the phases pass. */
function Progress({ u }: { u: UpdateInfo }) {
  const s = u.status;
  if (!s || !(u.inProgress || (s.at && Date.now() - s.at < 3600_000 && s.phase !== "done"))) return null;
  const order = ["queued", "downloading", "verifying", "installing", "restarting"];
  const at = Math.max(0, order.indexOf(s.phase));
  const failed = s.phase === "failed" || s.phase === "rolled_back";
  return (
    <div className="mt-3" role="status">
      <div className="flex items-center justify-between gap-3 text-compact">
        <span className={failed ? "text-critical" : "text-ink-2"}>{PHASE[s.phase as keyof typeof PHASE] ?? s.phase}</span>
        {!failed && <span className="text-ink-3 tabular-nums">{Math.round(((at + 1) / (order.length + 1)) * 100)}%</span>}
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-surface-3 overflow-hidden" aria-hidden><div className={`h-full rounded-full transition-all duration-(--duration-base) ${failed ? "bg-critical" : "bg-accent"}`} style={{ width: failed ? "100%" : `${((at + 1) / (order.length + 1)) * 100}%` }} /></div>
      {s.message && <p className="text-compact text-ink-3 mt-1.5 text-pretty">{s.message}{u.inProgress && " This page reconnects by itself when the host service restarts."}</p>}
    </div>
  );
}

/** Asks in place before something that restarts the service; no dialog, no typed phrase. */
function Confirm({ text, action, busy, error, onYes, onNo }: { text: ReactNode; action: string; busy?: boolean; error?: string | null; onYes: () => void; onNo: () => void }) {
  return (
    <div className="mt-3 rounded-lg border border-line bg-surface-2/60 px-4 py-3">
      <p className="text-compact text-ink-2 text-pretty">{text}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" loading={busy} onClick={onYes}>{action}</Button>
        <Button size="sm" variant="ghost" onClick={onNo}>Cancel</Button>
      </div>
      {error && <p role="alert" className="text-compact text-critical mt-2">{error}</p>}
    </div>
  );
}

function LiveUpdates() {
  const qc = useQueryClient();
  const { setup, host } = useEngine();
  const { node, name } = useNodeName();
  const device = setup?.deviceName ?? "pve";
  const pve = useQuery({ queryKey: ["node", "updates", name], queryFn: () => nodeApi.updates(node), retry: 1 });
  const me = useUpdate();
  const check = useMutation({ mutationFn: pinRt.checkUpdate, onSuccess: (d: UpdateInfo) => qc.setQueryData(["pin", "update"], d) });
  const [asking, setAsking] = useState(false);
  const [notes, setNotes] = useState(false);
  const start = useMutation({ mutationFn: pinRt.startUpdate, onSuccess: () => { setAsking(false); void me.refetch(); } });

  const packages = pve.data?.packages.length ?? 0;
  const pveVersion = proxmoxVersion(pve.data?.version ?? host.version);
  const u = me.data;
  const meNew = u?.state === "available";
  const loading = pve.isPending || me.isPending;
  const waiting = packages > 0 || meNew;
  const installing = !!u?.inProgress;
  const canInstall = !!u && meNew && u.canUpdate && !installing && !u.paused;
  const lookBack = () => {
    void pve.refetch();
    check.mutate();
  };
  const headline = loading ? "Checking for updates…" : installing ? "Updates in progress" : u?.paused ? "Updates are paused" : waiting ? "Updates are available" : "You're up to date";
  const checked = u?.checkedAt ? `Last checked ${ago(u.checkedAt)}` : "Not checked yet";

  return (
    <>
      <Card className="p-6 mb-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
          <span className={`h-14 w-14 shrink-0 rounded-full flex items-center justify-center ${loading || installing ? "bg-surface-2 text-ink-3" : waiting ? "bg-warning/10 text-warning" : "bg-good/10 text-good"}`} aria-hidden>
            {loading || installing ? <Loader2 className="h-7 w-7 animate-spin" /> : waiting ? <ArrowUpCircle className="h-7 w-7" /> : <CheckCircle2 className="h-7 w-7" />}
          </span>
          <div className="min-w-0 flex-1 basis-56">
            <h2 className="text-title font-semibold tracking-tight text-balance">{headline}</h2>
            <p className="text-compact text-ink-3 mt-0.5">{checked}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canInstall && <Button variant="primary" onClick={() => setAsking(true)}><Download className="h-4 w-4" />Install now</Button>}
            <Button variant={canInstall ? "secondary" : "primary"} loading={check.isPending} disabled={installing} onClick={lookBack}><RefreshCw className="h-4 w-4" />Check for updates</Button>
          </div>
        </div>
        {u && <Progress u={u} />}
        {u?.error && <p role="alert" className="text-compact text-warning mt-4 text-pretty">The release feed didn't answer ({u.error}). Your installed version is unaffected.</p>}
        {u?.paused && u.policy.pausedUntil && <p className="text-compact text-ink-2 mt-4">Updates are paused until {new Date(u.policy.pausedUntil).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}. You can still install by hand.</p>}
      </Card>
      {u && <div className="mb-4 space-y-3">
        {u.installedWithdrawn && <Notice tone="critical" title="The version you're running was withdrawn">{u.installedWithdrawn} Update to a newer version as soon as you can.</Notice>}
        <RestartNotice u={u} device={device} />
      </div>}

      {waiting && (
        <section className="mb-6">
          <h2 className="text-compact font-semibold text-ink-2 px-1 mb-3">Available updates</h2>
          <Card className="divide-y divide-line">
            {meNew && u && (
              <div className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <span className="h-10 w-10 shrink-0 rounded-lg bg-surface-2 text-ink-2 flex items-center justify-center" aria-hidden><Paperclip className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1 basis-48">
                    <div className="font-medium">ePaperclip {u.latest?.version}</div>
                    <div className="text-compact text-ink-3">Installed <span className="font-mono">{u.installed ?? "unknown"}</span>. Restarts ePaperclip for a minute or two; machines keep running.</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setNotes((v) => !v)} aria-expanded={notes}>{notes ? "Hide what's new" : "What's new"}</Button>
                </div>
                {notes && (
                  <div className="mt-3 max-h-72 overflow-y-auto overflow-x-hidden rounded-lg border border-line p-4 text-compact text-ink-2">
                    {u.latest?.notes ? <Markdown text={u.latest.notes} chat /> : "No release notes were published."}
                  </div>
                )}
                {asking && u.latest && (
                  <Confirm
                    text={<>Download ePaperclip {u.latest.version}, check it against its published SHA-256, test-start it beside the running version, then switch over. People signed in will need to sign in again, and if the new version doesn't come up the previous one returns by itself.</>}
                    action="Install" busy={start.isPending} error={start.error ? errorMessage(start.error) : null}
                    onYes={() => start.mutate({ action: "update", confirm: `update ${u.latest!.version}` })} onNo={() => setAsking(false)}
                  />
                )}
                {!u.canUpdate && u.canManage && <p className="text-compact text-ink-3 mt-3">This device doesn't have the update helper. Run <span className="font-mono">{u.manual}</span> in its shell.</p>}
              </div>
            )}
            {packages > 0 && (
              <Link to={`/${device}/host/updates`} className="transition-control group flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 hover:bg-surface-2 last:rounded-b-xl first:rounded-t-xl">
                <span className="h-10 w-10 shrink-0 rounded-lg bg-surface-2 text-ink-2 flex items-center justify-center group-hover:bg-surface-3" aria-hidden><Server className="h-5 w-5" /></span>
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block font-medium">Proxmox VE packages</span>
                  <span className="block text-compact text-ink-3">{packages} {packages === 1 ? "package has" : "packages have"} an update{pve.data?.kernelUpdatePending ? ", including a new kernel" : ""}.</span>
                </span>
                <span className="inline-flex items-center gap-0.5 text-compact text-ink-2 group-hover:text-ink">Review<ChevronRight className="h-4 w-4" aria-hidden /></span>
              </Link>
            )}
          </Card>
        </section>
      )}

      <section className="mb-6">
        <h2 className="text-compact font-semibold text-ink-2 px-1 mb-3">Installed</h2>
        <Card className="divide-y divide-line">
          <Row
            to={`/${device}/pin?tab=updates`}
            icon={<Paperclip className="h-5 w-5" />}
            name="ePaperclip"
            detail={me.isPending ? "Checking…" : <>Version <span className="font-mono">{u?.installed ?? "unknown"}</span></>}
            status={me.isPending ? <Status kind="idle" label="Checking" /> : meNew ? <Status kind="warning" label="Update available" /> : u?.state === "current" ? <Status kind="good" label="Up to date" /> : <Status kind="idle" label="Not compared" />}
            action="Details"
          />
          <Row
            to={`/${device}/host/updates`}
            icon={<Server className="h-5 w-5" />}
            name="Proxmox VE"
            detail={pve.isPending ? "Checking…" : pve.error ? "Couldn't read the package list" : <>Version <span className="font-mono">{pveVersion || "unknown"}</span>{pve.data?.rebootRequired ? " · restart needed for the new kernel" : ""}</>}
            status={pve.isPending ? <Status kind="idle" label="Checking" /> : pve.data?.listDenied ? <Status kind="idle" label="Your account can't read updates" /> : packages > 0 ? <Status kind="warning" label={`${packages} to install`} /> : <Status kind="good" label="Up to date" />}
            action="Details"
          />
        </Card>
      </section>
      {u && <UpdateOptions u={u} device={device} part="main" />}
    </>
  );
}

function BackLink({ device }: { device: string }) {
  return <Link to={`/${device}/updates`} className="transition-control inline-flex items-center gap-1 text-compact text-ink-2 hover:text-ink mb-4"><ChevronLeft className="h-4 w-4" aria-hidden />Updates</Link>;
}

/** Updates → Update history: a page of its own, not a dialog. */
export function UpdatesHistoryPage() {
  const { setup } = useEngine();
  const device = setup?.deviceName ?? "pve";
  return (
    <PageFrame width="3xl">
      <BackLink device={device} />
      <PageHeader title="Update history" subtitle="ePaperclip's own updates and the package changes Proxmox made." />
      <UpdateHistory />
    </PageFrame>
  );
}

/** Updates → Advanced options: maintenance window, the feed, and going back a version. */
export function UpdatesAdvancedPage() {
  const { setup } = useEngine();
  const device = setup?.deviceName ?? "pve";
  const me = useUpdate();
  const [asking, setAsking] = useState(false);
  const back = useMutation({ mutationFn: pinRt.startUpdate, onSuccess: () => { setAsking(false); void me.refetch(); } });
  const u = me.data;
  return (
    <PageFrame width="3xl">
      <BackLink device={device} />
      <PageHeader title="Advanced options" subtitle="How this device installs updates, which feed it trusts, and how to go back." />
      {me.isPending && <div className="py-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-ink-3" aria-hidden /></div>}
      {u && (
        <div className="space-y-6">
          <UpdateOptions u={u} device={device} part="advanced" />
          {u.canManage && u.canUpdate && (
            <Card className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                <span className="h-9 w-9 shrink-0 rounded-lg bg-surface-2 text-ink-2 flex items-center justify-center" aria-hidden><RotateCcw className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1 basis-60">
                  <div className="text-sm font-medium">Go back to the previous version</div>
                  <div className="text-compact text-ink-3 text-pretty">{u.previous ? <>Puts back <span className="font-mono">{u.previous}</span>, and the engine's database from before the last update if the engine changed.</> : "No earlier version is kept on this device yet."}</div>
                </div>
                <Button disabled={!u.previous || u.inProgress} onClick={() => setAsking(true)}>Go back…</Button>
              </div>
              {asking && <Confirm text="ePaperclip restarts for a minute or two. Machines and organizations keep running." action="Go back" busy={back.isPending} error={back.error ? errorMessage(back.error) : null} onYes={() => back.mutate({ action: "rollback", confirm: "rollback" })} onNo={() => setAsking(false)} />}
            </Card>
          )}
        </div>
      )}
    </PageFrame>
  );
}

export function Updates() {
  const { data, host, live } = useEngine();
  const pin = usePin();
  const updates = data.notices.filter((n) => n.kind === "update");
  return (
    <PageFrame width="3xl">
      <PageHeader title="Updates" subtitle="Pin follows Proxmox and ePaperclip releases and tells you when something new lands. Updates are applied only when you approve, after snapshots." actions={<Button onClick={() => pin.send("Are there any updates?")}>Ask Pin</Button>} />
      {live ? (
        <LiveUpdates />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
            <Card className="p-5"><div className="text-xs text-ink-3">Proxmox VE</div><div className="text-xl font-semibold mt-1 break-words">{proxmoxVersion(host.version)}</div>{updates.length ? <Status kind="warning" label="Update available" /> : <Status kind="good" label="Up to date" />}</Card>
            <Card className="p-5"><div className="text-xs text-ink-3">ePaperclip</div><div className="text-xl font-semibold mt-1">0.1.0</div><Status kind="good" label="Up to date" /></Card>
          </div>
          <div className="space-y-3">
            {updates.length === 0 && <Card className="p-5 flex items-center gap-3"><CheckCircle2 className="h-5 w-5 text-good" />Everything is up to date.</Card>}
            {updates.map((u) => (
              <Card key={u.id} className="p-5">
                <div className="font-medium">{u.title}</div>
                <p className="text-sm text-ink-2 mt-1">{u.body}</p>
                <div className="mt-4 flex gap-2">
                  <Button variant="primary" disabled title="Applying updates arrives with the host broker"><Download className="h-4 w-4" />Snapshot and update</Button>
                  <Button variant="ghost" onClick={() => pin.send("What's in the update?")}>Ask Pin about it</Button>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </PageFrame>
  );
}
