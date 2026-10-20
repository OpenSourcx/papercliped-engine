import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, CheckCircle2, FileText, Package, RefreshCw, RotateCcw, TerminalSquare } from "lucide-react";
import { nodeApi, type RepoEntry, type UpdatePackage } from "../../data/engine/nodeApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { useEngine } from "../../data/store.tsx";
import { Terminal } from "../../terminal/LazyTerminal.tsx";
import { LiveTransport } from "../../terminal/transport.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Input, Notice, PageFrame, PageHeader, Status, Tabs, Toggle } from "../../ui/primitives.tsx";
import { RebootDialog } from "./Power.tsx";
import { Async, LiveOnly, NodeSwitcher, TasksLink, TypedConfirm, useNodeName, useTaskRunner } from "./common.tsx";

type Tab = "updates" | "repositories";

function Changelog({ pkg, onClose }: { pkg: UpdatePackage; onClose: () => void }) {
  const { node } = useNodeName();
  const q = useQuery({ queryKey: ["node", "changelog", node, pkg.package, pkg.version], queryFn: () => nodeApi.changelog(node, pkg.package, pkg.version), retry: 0, staleTime: 5 * 60_000 });
  return (
    <Modal size="lg" icon={<FileText className="h-5 w-5" />} title={pkg.package} subtitle={`${pkg.oldVersion ? `${pkg.oldVersion} to ` : ""}${pkg.version}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {q.isPending ? <p className="text-compact text-ink-3">Fetching the changelog…</p> : q.error ? <Notice tone="warning" title="No changelog">{errorText(q.error)}</Notice> : <pre aria-label="Changelog" className="rounded-lg bg-code border border-line p-3 text-xs leading-relaxed font-mono text-ink-2 max-h-[50vh] overflow-auto whitespace-pre-wrap break-words">{q.data.text || "(empty)"}</pre>}
    </Modal>
  );
}

/** The upgrade runs in Proxmox's own upgrade terminal: Proxmox has no task for it, and apt may ask questions. */
function UpgradeTerminal({ onClose }: { onClose: () => void }) {
  const make = useMemo(() => () => new LiveTransport("/api/console/node?cmd=upgrade" as "/api/console/node"), []);
  return (
    <Modal size="lg" icon={<TerminalSquare className="h-5 w-5" />} title="Upgrade packages" subtitle="Proxmox's upgrade terminal. Answer apt's questions here; close it when it says it's done." onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <Terminal make={make} title="apt full-upgrade" className="h-[min(480px,60vh)]" />
    </Modal>
  );
}

function UpdatesTab() {
  const { node, name } = useNodeName();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["node", "updates", name], queryFn: () => nodeApi.updates(node), retry: 1 });
  const runner = useTaskRunner(() => void qc.invalidateQueries({ queryKey: ["node", "updates"] }));
  const [log, setLog] = useState<UpdatePackage | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [filter, setFilter] = useState("");
  return (
    <Async q={q}>
      {(u) => {
        const shown = u.packages.filter((p) => !filter.trim() || p.package.includes(filter.trim().toLowerCase()));
        return (
          <div className="space-y-4">
            {u.rebootRequired && <Notice tone="warning" title="Reboot required" action={<Button size="sm" variant="primary" onClick={() => setRestarting(true)}><RotateCcw className="h-3.5 w-3.5" />Restart now…</Button>}>The newest installed kernel ({u.newestInstalledKernel}) is not the one running ({u.runningKernel}). Reboot {u.packages.length ? "after the upgrade" : "when it suits you"} to start using it.</Notice>}
            {u.listDenied && <Notice tone="info" title="Your Proxmox account can't list updates">Proxmox needs the Sys.Modify permission on the device to read or refresh the update list.</Notice>}
            {u.listError && <Notice tone="critical" title="Proxmox couldn't list updates">{u.listError}</Notice>}
            {runner.error && <Notice tone="critical">{runner.error}</Notice>}
            <Card className="p-5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1 basis-60">
                  <div className="font-medium">{u.listDenied ? "Update status unavailable" : u.packages.length === 0 ? "Everything is up to date" : `${u.packages.length} ${u.packages.length === 1 ? "package has" : "packages have"} an update`}</div>
                  <div className="text-compact text-ink-3 mt-0.5">{u.version ?? "Proxmox VE"}{u.runningKernel ? ` · kernel ${u.runningKernel}` : ""}. Refresh checks Proxmox's package servers.</div>
                </div>
                <Button loading={runner.busy} onClick={() => void runner.start("Refresh package list", () => nodeApi.refreshUpdates(node))}><RefreshCw className="h-4 w-4" />Refresh list</Button>
                <Button variant="primary" disabled={!u.packages.length} onClick={() => setUpgrading(true)}><ArrowUpCircle className="h-4 w-4" />Upgrade…</Button>
              </div>
            </Card>
            {u.packages.length > 0 && (
              <Card className="overflow-hidden">
                <div className="p-3 border-b border-line"><label className="sr-only" htmlFor="pkg-filter">Filter packages</label><Input id="pkg-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter packages" className="max-w-xs" /></div>
                <div className="overflow-auto max-h-[min(70vh,640px)]">
                <table className="w-full text-compact min-w-[640px]">
                  <thead className="sticky top-0 bg-surface"><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">Package</th><th className="font-normal px-3">Installed</th><th className="font-normal px-3">New</th><th className="font-normal px-3 hidden sm:table-cell">From</th></tr></thead>
                  <tbody>
                    {shown.map((p) => (
                      <tr key={`${p.package}:${p.arch}`} className="border-b border-line last:border-0">
                        <td className="px-4 py-2.5"><button className="text-left hover:underline underline-offset-2" onClick={() => setLog(p)} aria-label={`Changelog for ${p.package}`}><span className="font-mono text-ink">{p.package}</span><span className="block text-xs text-ink-3 max-w-md truncate">{p.title}</span></button></td>
                        <td className="px-3 font-mono tabular-nums text-ink-2">{p.oldVersion ?? "New"}</td>
                        <td className="px-3 font-mono tabular-nums">{p.version}</td>
                        <td className="px-3 hidden sm:table-cell text-ink-2">{p.origin}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </Card>
            )}
            {u.packages.length === 0 && !u.listDenied && !u.listError && <Card><EmptyState icon={<CheckCircle2 className="h-5 w-5" />} title="Nothing to install" body="Press Refresh list to ask Proxmox's package servers again." /></Card>}
            {log && <Changelog pkg={log} onClose={() => setLog(null)} />}
            {restarting && <RebootDialog onClose={() => setRestarting(false)} />}
            {upgrading && (
              <TypedConfirm title={`Upgrade ${u.packages.length} ${u.packages.length === 1 ? "package" : "packages"} on ${u.node}?`} phrase="upgrade" action="Open upgrade terminal" onClose={() => setUpgrading(false)} onConfirm={() => { setUpgrading(false); setTerminal(true); }}>
                <div className="space-y-3">
                  <Notice tone="warning" title="Take a backup or snapshot first if this device matters.">The upgrade changes system packages while machines keep running. Services may restart.</Notice>
                  {u.kernelUpdatePending && <Notice tone="warning" title="A new kernel is included">The device must reboot afterwards to use it. Reboot is under Power and subscription.</Notice>}
                </div>
              </TypedConfirm>
            )}
            {terminal && <UpgradeTerminal onClose={() => { setTerminal(false); void qc.invalidateQueries({ queryKey: ["node", "updates"] }); }} />}
            {runner.modal}
          </div>
        );
      }}
    </Async>
  );
}

const KIND_LABEL: Record<string, string> = { enterprise: "Enterprise", "no-subscription": "No-subscription", test: "Test", "ceph-enterprise": "Ceph enterprise", "ceph-no-subscription": "Ceph no-subscription", "ceph-test": "Ceph test", debian: "Debian", other: "Other" };

function RepositoriesTab() {
  const { node, name } = useNodeName();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["node", "repos", name], queryFn: () => nodeApi.repos(node), retry: 1 });
  const refresh = () => qc.invalidateQueries({ queryKey: ["node", "repos"] });
  const toggle = useMutation({ mutationFn: (v: { r: RepoEntry; enabled: boolean; digest: string | null }) => nodeApi.toggleRepo(node, { path: v.r.path, index: v.r.index, enabled: v.enabled, digest: v.digest }), onSuccess: () => void refresh() });
  const add = useMutation({ mutationFn: (v: { handle: string; digest: string | null }) => nodeApi.addRepo(node, v.handle, v.digest), onSuccess: () => void refresh() });
  const sw = useMutation({ mutationFn: () => nodeApi.switchToNoSubscription(node), onSuccess: () => void refresh() });
  const err = toggle.error ?? add.error ?? sw.error;
  return (
    <Async q={q}>
      {(r) => (
        <div className="space-y-4">
          {r.warnings.map((w) => (
            <Notice key={w.id} tone={w.tone === "info" ? "info" : "warning"} action={w.fix === "no-subscription" ? <Button size="sm" loading={sw.isPending} onClick={() => sw.mutate()}>Use no-subscription</Button> : undefined}>{w.message}</Notice>
          ))}
          {r.errors.map((e) => <Notice key={e.path} tone="critical" title={e.path}>{e.error}</Notice>)}
          {sw.isSuccess && <Notice tone="good">The enterprise repository is off and the no-subscription repository is on. Refresh the package list to use it.</Notice>}
          {err && <Notice tone="critical" title="Proxmox didn't change the repositories">{errorText(err)}</Notice>}
          <Card className="overflow-x-auto edge-fade-x">
            <table className="w-full text-compact min-w-[680px]">
              <thead><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">Repository</th><th className="font-normal px-3">Suite and components</th><th className="font-normal px-3 w-px">On</th></tr></thead>
              <tbody>
                {r.repositories.map((x) => (
                  <tr key={`${x.path}:${x.index}`} className="border-b border-line last:border-0">
                    <td className="px-4 py-3 min-w-0"><div className="flex items-center gap-2"><Chip tone={x.kind === "enterprise" ? "accent" : x.kind === "test" ? "warning" : "neutral"}>{KIND_LABEL[x.kind] ?? x.kind}</Chip><span className="font-mono text-xs text-ink-2 truncate">{x.types.join(", ")}</span></div><div className="font-mono text-xs text-ink-3 mt-1 break-all">{x.uris.join(" ")}</div></td>
                    <td className="px-3 font-mono text-xs text-ink-2">{x.suites.join(" ")} {x.components.join(" ")}</td>
                    <td className="px-3"><Toggle checked={x.enabled} label={`${KIND_LABEL[x.kind] ?? x.kind} repository ${x.uris[0] ?? ""}`} disabled={toggle.isPending} onChange={(v) => toggle.mutate({ r: x, enabled: v, digest: r.digest })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {r.standardRepos.some((s) => s.status === "missing") && (
            <Card className="p-5">
              <div className="font-medium mb-1">Add a standard repository</div>
              <p className="text-compact text-ink-3 mb-3">Proxmox's own repositories for this release. They are added switched on.</p>
              <div className="flex flex-wrap gap-2">
                {r.standardRepos.filter((s) => s.status === "missing").map((s) => <Button key={s.handle} size="sm" loading={add.isPending && add.variables?.handle === s.handle} onClick={() => add.mutate({ handle: s.handle, digest: r.digest })}>{s.name}</Button>)}
              </div>
            </Card>
          )}
          {r.infos.length > 0 && <ul className="text-compact text-ink-3 space-y-1">{r.infos.map((i, n) => <li key={n}>{i.message}</li>)}</ul>}
        </div>
      )}
    </Async>
  );
}

function UpdatesBody() {
  const [tab, setTab] = useState<Tab>("updates");
  return (
    <>
      <Tabs<Tab> value={tab} onChange={setTab} className="mb-6" tabs={[{ id: "updates", label: "Packages" }, { id: "repositories", label: "Repositories" }]} />
      {tab === "updates" ? <UpdatesTab /> : <RepositoriesTab />}
    </>
  );
}

export function NodeUpdatesPage() {
  const { name, multi } = useNodeName();
  return (
    <PageFrame width="6xl">
      <PageHeader title="Updates" subtitle={`Package updates and sources for ${name}.`} actions={<>{multi && <NodeSwitcher />}<TasksLink type="aptupdate" /></>} />
      <LiveOnly><UpdatesBody /></LiveOnly>
    </PageFrame>
  );
}
