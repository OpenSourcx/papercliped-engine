import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Play, RefreshCw, RotateCw, Square } from "lucide-react";
import { nodeApi, type ServiceInfo } from "../../data/engine/nodeApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Button, Card, Field, Input, Notice, PageFrame, PageHeader, Select, Status } from "../../ui/primitives.tsx";
import { useConfirm } from "../../ui/Confirm.tsx";
import { Async, LiveOnly, NodeSwitcher, TasksLink, TypedConfirm, useNodeName } from "./common.tsx";

type Action = "start" | "stop" | "restart" | "reload";
/** Stopping these can cut the node off from its cluster, its console or the people running it. */
const CRITICAL = new Set(["pve-cluster", "corosync", "pvedaemon", "pveproxy", "sshd", "pve-ha-lrm", "pve-ha-crm", "pvescheduler", "pvestatd", "lxcfs"]);
const needsTyping = (service: string, action: Action) => CRITICAL.has(service) && (action === "stop" || (action === "restart" && (service === "pve-cluster" || service === "corosync")));

function ServicesBody() {
  const { node, name } = useNodeName();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["node", "services", name], queryFn: () => nodeApi.services(node), refetchInterval: 10_000 });
  const [asking, setAsking] = useState<{ s: ServiceInfo; action: Action } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (v: { service: string; action: Action; confirm?: string }) => nodeApi.serviceAction(node, v.service, v.action, v.confirm),
    onSuccess: (_r, v) => {
      setNote(`${v.action === "stop" ? "Stop" : v.action === "start" ? "Start" : v.action === "restart" ? "Restart" : "Reload"} sent to ${v.service}.`);
      setAsking(null);
      void qc.invalidateQueries({ queryKey: ["node", "services"] });
    },
  });
  const { ask, dialog } = useConfirm();
  const go = (s: ServiceInfo, action: Action) => {
    if (needsTyping(s.service, action)) return setAsking({ s, action });
    if (action === "start") return run.mutate({ service: s.service, action });
    const verb = action === "stop" ? "Stop" : action === "restart" ? "Restart" : "Reload";
    ask({ title: `${verb} ${s.service}?`, body: action === "stop" ? `${s.service} stays off until someone starts it again, and whatever depends on it stops working.` : action === "restart" ? `${s.service} is stopped and started again, so it is briefly unavailable.` : `${s.service} re-reads its settings without stopping.`, label: verb, danger: action !== "reload", run: () => run.mutate({ service: s.service, action }) });
  };

  return (
    <Async q={q}>
      {(data) => (
        <>
          {dialog}
          {note && <Notice tone="good" className="mb-4">{note}</Notice>}
          {run.error && !asking && <Notice tone="critical" className="mb-4" title="Proxmox didn't do that">{errorText(run.error)}</Notice>}
          <Card className="overflow-x-auto edge-fade-x">
            <table className="w-full text-compact min-w-[640px]">
              <thead>
                <tr className="border-b border-line text-ink-3 text-left">
                  <th className="font-normal px-4 h-10">Service</th>
                  <th className="font-normal px-3">State</th>
                  <th className="font-normal px-3 hidden sm:table-cell">Starts at boot</th>
                  <th className="px-3 w-px"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {data.services.map((s) => {
                  const up = s.state === "running";
                  return (
                    <tr key={s.service} className="border-b border-line last:border-0">
                      <td className="px-4 py-3"><div className="font-mono text-ink">{s.service}</div><div className="text-xs text-ink-3">{s.description}</div></td>
                      <td className="px-3">{up ? <Status kind="good" label="Running" /> : <Status kind="off" label="Stopped" />}</td>
                      <td className="px-3 hidden sm:table-cell text-ink-2">{s.unitState ?? "unknown"}</td>
                      <td className="px-3">
                        {s.canControl ? (
                          <div className="flex gap-1.5 justify-end">
                            {!up && <Button size="sm" onClick={() => go(s, "start")} disabled={run.isPending} aria-label={`Start ${s.service}`}><Play className="h-4 w-4" />Start</Button>}
                            {up && <Button size="sm" onClick={() => go(s, "restart")} disabled={run.isPending} aria-label={`Restart ${s.service}`}><RotateCw className="h-4 w-4" />Restart</Button>}
                            {up && <Button size="sm" onClick={() => go(s, "reload")} disabled={run.isPending} aria-label={`Reload ${s.service}`}><RefreshCw className="h-4 w-4" />Reload</Button>}
                            {up && <Button size="sm" variant="danger" onClick={() => go(s, "stop")} disabled={run.isPending} aria-label={`Stop ${s.service}`}><Square className="h-4 w-4" />Stop</Button>}
                          </div>
                        ) : <span className="text-xs text-ink-3">Managed by Proxmox</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
          {asking && (
            <TypedConfirm title={`${asking.action === "stop" ? "Stop" : "Restart"} ${asking.s.service}?`} subtitle={`On ${data.node}`} phrase={asking.s.service} action={asking.action === "stop" ? "Stop service" : "Restart service"} busy={run.isPending} error={run.error ? errorText(run.error) : null} onClose={() => { setAsking(null); run.reset(); }} onConfirm={() => run.mutate({ service: asking.s.service, action: asking.action, confirm: asking.s.service })}>
              <Notice tone="warning">{asking.s.service} keeps this device working with the rest of the datacenter or the people signed in to it. Stopping it can interrupt machines, the console or access to the device until it is started again.</Notice>
            </TypedConfirm>
          )}
        </>
      )}
    </Async>
  );
}

export function ServicesPage() {
  const { name, multi } = useNodeName();
  return (
    <PageFrame width="6xl">
      <PageHeader title="Services" subtitle={`The system services running on ${name}. Start, stop, restart or reload one when Proxmox asks you to.`} actions={<>{multi && <NodeSwitcher />}<TasksLink type="srvstart" label="Tasks" /></>} />
      <LiveOnly><ServicesBody /></LiveOnly>
    </PageFrame>
  );
}

/* ── Time ──────────────────────────────────────────────────────────────────────────── */

const ZONES = typeof Intl !== "undefined" && "supportedValuesOf" in Intl ? (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone") : [];

function TimeBody() {
  const { node, name } = useNodeName();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["node", "time", name], queryFn: () => nodeApi.time(node), refetchInterval: 30_000 });
  const [zone, setZone] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (tz: string) => nodeApi.setTimezone(node, tz),
    onSuccess: () => {
      setZone(null);
      void qc.invalidateQueries({ queryKey: ["node", "time"] });
    },
  });
  return (
    <Async q={q}>
      {(t) => {
        const current = zone ?? t.timezone;
        const zones = ZONES.includes(t.timezone) || !ZONES.length ? ZONES : [t.timezone, ...ZONES];
        return (
          <Card className="p-5 max-w-xl">
            <dl className="grid grid-cols-2 gap-4 mb-5">
              <div><dt className="text-xs text-ink-3">Time on the device (UTC)</dt><dd className="font-mono tabular-nums">{new Date(t.time * 1000).toISOString().replace("T", " ").slice(0, 19)}</dd></div>
              <div><dt className="text-xs text-ink-3">Local time there</dt><dd className="font-mono tabular-nums">{new Date(t.localtime * 1000).toISOString().replace("T", " ").slice(0, 19)}</dd></div>
            </dl>
            <Field label="Time zone" hint="Used for logs, schedules and backup times on this device." htmlFor="tz">
              {zones.length ? (
                <Select id="tz" value={current} onChange={(e) => setZone(e.target.value)}>{zones.map((z) => <option key={z} value={z}>{z}</option>)}</Select>
              ) : (
                <Input id="tz" className="font-mono" value={current} onChange={(e) => setZone(e.target.value)} />
              )}
            </Field>
            {save.error && <p role="alert" className="text-compact text-critical mt-3">{errorText(save.error)}</p>}
            <div className="mt-5"><Button variant="primary" disabled={zone === null || zone === t.timezone} loading={save.isPending} onClick={() => save.mutate(current)}>Save time zone</Button></div>
          </Card>
        );
      }}
    </Async>
  );
}

export function TimePage() {
  const { name, multi } = useNodeName();
  return (
    <PageFrame width="4xl">
      <PageHeader title="Time and time zone" subtitle={`The clock and time zone of ${name}. The clock itself is kept right by the time service (chrony), listed under Services.`} eyebrow={<Clock className="h-4 w-4 inline mr-1.5" aria-hidden />} actions={multi ? <NodeSwitcher /> : undefined} />
      <LiveOnly><TimeBody /></LiveOnly>
    </PageFrame>
  );
}
