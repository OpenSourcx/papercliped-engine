import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, CheckCircle2, ChevronRight, Download, Loader2, Paperclip, RefreshCw, Server } from "lucide-react";
import { useEngine } from "../data/store.tsx";
import { nodeApi } from "../data/engine/nodeApi.ts";
import { pinRt, type UpdateInfo } from "../data/engine/pinRuntimeApi.ts";
import { proxmoxVersion } from "../lib/version.ts";
import { usePin } from "../pin/PinContext.tsx";
import { ago } from "./pin/runtime.tsx";
import { useNodeName } from "./node/common.tsx";
import { Button, Card, PageHeader, Status, PageFrame } from "../ui/primitives.tsx";

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

function LiveUpdates() {
  const qc = useQueryClient();
  const { setup, host } = useEngine();
  const { node, name } = useNodeName();
  const device = setup?.deviceName ?? "pve";
  const pve = useQuery({ queryKey: ["node", "updates", name], queryFn: () => nodeApi.updates(node), retry: 1 });
  const me = useQuery({ queryKey: ["pin", "update"], queryFn: pinRt.update, retry: 1, refetchInterval: (q) => (q.state.data?.inProgress ? 3000 : 600_000) });
  const check = useMutation({ mutationFn: pinRt.checkUpdate, onSuccess: (d: UpdateInfo) => qc.setQueryData(["pin", "update"], d) });

  const packages = pve.data?.packages.length ?? 0;
  const pveVersion = proxmoxVersion(pve.data?.version ?? host.version);
  const meNow = me.data;
  const meNew = meNow?.state === "available";
  const loading = pve.isPending || me.isPending;
  const waiting = packages > 0 || meNew;
  const lookBack = () => {
    void pve.refetch();
    check.mutate();
  };
  const headline = loading ? "Checking for updates…" : waiting ? "Updates are available" : "You're up to date";
  const checked = meNow?.checkedAt ? `Last checked ${ago(meNow.checkedAt)}` : "Not checked yet";

  return (
    <>
      <Card className="p-6 mb-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
          <span className={`h-14 w-14 shrink-0 rounded-full flex items-center justify-center ${loading ? "bg-surface-2 text-ink-3" : waiting ? "bg-warning/10 text-warning" : "bg-good/10 text-good"}`} aria-hidden>
            {loading ? <Loader2 className="h-7 w-7 animate-spin" /> : waiting ? <ArrowUpCircle className="h-7 w-7" /> : <CheckCircle2 className="h-7 w-7" />}
          </span>
          <div className="min-w-0 flex-1 basis-56">
            <h2 className="text-title font-semibold tracking-tight text-balance">{headline}</h2>
            <p className="text-compact text-ink-3 mt-0.5">{checked}</p>
          </div>
          <Button variant="primary" loading={check.isPending} onClick={lookBack}><RefreshCw className="h-4 w-4" />Check for updates</Button>
        </div>
        {meNow?.error && <p role="alert" className="text-compact text-warning mt-4 text-pretty">The release feed didn't answer ({meNow.error}). Your installed version is unaffected.</p>}
      </Card>

      <Card className="divide-y divide-line">
        <Row
          to={`/${device}/pin?tab=updates`}
          icon={<Paperclip className="h-5 w-5" />}
          name="ePaperclip"
          detail={me.isPending ? "Checking…" : <>Installed <span className="font-mono">{meNow?.installed ?? "unknown"}</span>{meNew && meNow?.latest ? <> · newer <span className="font-mono">{meNow.latest.version}</span></> : null}</>}
          status={me.isPending ? <Status kind="idle" label="Checking" /> : meNew ? <Status kind="warning" label="Update available" /> : meNow?.state === "current" ? <Status kind="good" label="Up to date" /> : <Status kind="idle" label={meNow?.state === "off" ? "Checks are off" : "Not compared yet"} />}
          action={meNew ? "Update" : "Details"}
        />
        <Row
          to={`/${device}/host/updates`}
          icon={<Server className="h-5 w-5" />}
          name="Proxmox VE"
          detail={pve.isPending ? "Checking…" : pve.error ? "Couldn't read the package list" : <>Version <span className="font-mono">{pveVersion || "unknown"}</span>{pve.data?.rebootRequired ? " · restart needed for the new kernel" : ""}</>}
          status={pve.isPending ? <Status kind="idle" label="Checking" /> : pve.data?.listDenied ? <Status kind="idle" label="Your account can't read updates" /> : packages > 0 ? <Status kind="warning" label={`${packages} ${packages === 1 ? "update" : "updates"}`} /> : <Status kind="good" label="Up to date" />}
          action={packages > 0 ? "Open updates" : "Details"}
        />
      </Card>
    </>
  );
}

export function Updates() {
  const { data, host, live } = useEngine();
  const pin = usePin();
  const updates = data.notices.filter((n) => n.kind === "update");
  return (
    <PageFrame width="3xl">
      <PageHeader title="Updates" subtitle="Pin follows Proxmox and ePaperclip releases and tells you when something new lands. Updates are applied only when you approve, after snapshots." actions={<Button onClick={() => pin.send("Are there any updates?")}><RefreshCw className="h-4 w-4" />Ask Pin</Button>} />
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
