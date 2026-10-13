import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Power, RotateCcw, Zap } from "lucide-react";
import { nodeApi, type PowerInfo } from "../../data/engine/nodeApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Button, Card, Chip, Field, Input, Notice, PageFrame, PageHeader, SectionTitle, Status } from "../../ui/primitives.tsx";
import { Async, LiveOnly, NodeSwitcher, TypedConfirm, useNodeName } from "./common.tsx";
import { httpUrl } from "../../lib/safeUrl";

function PowerCard({ info }: { info: PowerInfo }) {
  const { node } = useNodeName();
  const [asking, setAsking] = useState<"reboot" | "shutdown" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (command: "reboot" | "shutdown") => nodeApi.powerCommand(node, command, info.node),
    onSuccess: (r, command) => {
      setAsking(null);
      setDone(r.selfAffected ? `${command === "reboot" ? "Rebooting" : "Shutting down"} ${info.node}. This page will lose its connection until the device is back.` : `${command === "reboot" ? "Reboot" : "Shutdown"} sent to ${info.node}.`);
    },
  });
  const n = info.running.length;
  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2 shrink-0"><Power className="h-4 w-4" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">Restart or turn off {info.node}</div>
          <p className="text-compact text-ink-3 mt-0.5">{info.runningUnknown ? "Your account can't list the machines on this device, so check them before you continue." : n === 0 ? "No machines are running here." : `${n} ${n === 1 ? "machine is" : "machines are"} running here and will be shut down.`}</p>
        </div>
      </div>
      {done && <Notice tone="good" className="mt-4">{done}</Notice>}
      <div className="flex flex-wrap gap-2 mt-4">
        <Button onClick={() => setAsking("reboot")}><RotateCcw className="h-4 w-4" />Reboot…</Button>
        <Button variant="danger" onClick={() => setAsking("shutdown")}><Power className="h-4 w-4" />Shut down…</Button>
      </div>
      {asking && (
        <TypedConfirm title={`${asking === "reboot" ? "Reboot" : "Shut down"} ${info.node}?`} phrase={info.node} action={asking === "reboot" ? "Reboot device" : "Shut down device"} busy={run.isPending} error={run.error ? errorText(run.error) : null} onClose={() => { setAsking(null); run.reset(); }} onConfirm={() => run.mutate(asking)}>
          <div className="space-y-3">
            <Notice tone="warning" title={asking === "reboot" ? "Everything on this device stops for a few minutes." : "Everything on this device stops until someone turns it back on."}>
              {info.local ? "This is the device you are signed in to, so ePaperclip, its console and Pin go away with it. " : ""}
              {asking === "shutdown" ? "Someone must press the power button, or wake it over the network, to start it again." : "Machines set to start at boot come back on their own."}
            </Notice>
            {n > 0 && (
              <div>
                <div className="text-compact font-medium text-ink-2 mb-1.5">Running now</div>
                <ul className="rounded-lg border border-line divide-y divide-line max-h-48 overflow-auto">
                  {info.running.map((g) => <li key={g.vmid} className="flex items-center gap-2 px-3 py-2 text-compact"><span className="font-mono text-ink-3 tabular-nums">{g.vmid}</span><span className="truncate">{g.name}</span><Chip className="ml-auto">{g.type === "lxc" ? "Container" : "Virtual machine"}</Chip></li>)}
                </ul>
              </div>
            )}
          </div>
        </TypedConfirm>
      )}
    </Card>
  );
}

function WakeCard({ info }: { info: PowerInfo }) {
  const [sent, setSent] = useState<string | null>(null);
  const wake = useMutation({ mutationFn: (n: string) => nodeApi.wakeOnLan(n), onSuccess: (_r, n) => setSent(n) });
  const off = info.others.filter((o) => !o.online);
  if (!off.length) return null;
  return (
    <Card className="p-5">
      <div className="font-medium mb-1">Wake a node</div>
      <p className="text-compact text-ink-3 mb-3">Sends a wake-on-LAN packet from {info.node} to a node that is switched off. The node needs its wake-on-LAN address set in Proxmox.</p>
      <ul className="divide-y divide-line">
        {off.map((o) => (
          <li key={o.node} className="flex items-center gap-3 py-2.5">
            <span className="font-mono flex-1">{o.node}</span>
            {sent === o.node ? <Status kind="good" label="Packet sent" /> : <Button size="sm" loading={wake.isPending && wake.variables === o.node} onClick={() => wake.mutate(o.node)}><Zap className="h-4 w-4" />Wake</Button>}
          </li>
        ))}
      </ul>
      {wake.error && <p role="alert" className="text-compact text-critical mt-2">{errorText(wake.error)}</p>}
    </Card>
  );
}

const SUB_STATUS: Record<string, { kind: "good" | "warning" | "critical" | "idle"; label: string }> = {
  active: { kind: "good", label: "Active" },
  new: { kind: "warning", label: "Key set, not checked yet" },
  notfound: { kind: "idle", label: "No subscription" },
  invalid: { kind: "critical", label: "Invalid key" },
  expired: { kind: "critical", label: "Expired" },
  suspended: { kind: "critical", label: "Suspended" },
};

function SubscriptionCard() {
  const { node, name } = useNodeName();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["node", "subscription", name], queryFn: () => nodeApi.subscription(node), retry: 1 });
  const [key, setKey] = useState("");
  const [removing, setRemoving] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["node", "subscription"] });
  const set = useMutation({ mutationFn: () => nodeApi.setSubscriptionKey(node, key.trim()), onSuccess: () => { setKey(""); void refresh(); } });
  const check = useMutation({ mutationFn: () => nodeApi.checkSubscription(node), onSuccess: () => void refresh() });
  const remove = useMutation({ mutationFn: () => nodeApi.removeSubscription(node, "remove subscription"), onSuccess: () => { setRemoving(false); void refresh(); } });
  return (
    <Async q={q}>
      {(s) => {
        const st = SUB_STATUS[s.status] ?? { kind: "idle" as const, label: s.status };
        return (
          <Card className="p-5">
            <div className="flex items-start gap-3">
              <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2 shrink-0"><BadgeCheck className="h-4 w-4" aria-hidden /></span>
              <div className="min-w-0 flex-1">
                <div className="font-medium">Proxmox subscription</div>
                <p className="text-compact text-ink-3 mt-0.5">{s.message ?? "A subscription gives access to the enterprise update repository and support."}</p>
              </div>
              <Status kind={st.kind} label={st.label} />
            </div>
            <dl className="grid sm:grid-cols-3 gap-x-6 gap-y-3 mt-4 text-compact">
              <div><dt className="text-xs text-ink-3">Plan</dt><dd>{s.productName ?? "None"}</dd></div>
              <div><dt className="text-xs text-ink-3">Key</dt><dd className="font-mono">{s.keyLast4 ? `…${s.keyLast4}` : "Not set"}</dd></div>
              <div><dt className="text-xs text-ink-3">Next due</dt><dd>{s.nextDueDate ?? "Not applicable"}</dd></div>
              <div className="sm:col-span-3"><dt className="text-xs text-ink-3">Server ID</dt><dd className="font-mono break-all">{s.serverId ?? "Unknown"}</dd></div>
            </dl>
            <div className="mt-5 grid sm:grid-cols-[1fr_auto] gap-2 items-end">
              <Field label={s.keyLast4 ? "Replace the key" : "Subscription key"} hint="Looks like pve2c-0123456789. It is sent to Proxmox and never shown again." htmlFor="sub-key"><Input id="sub-key" value={key} onChange={(e) => setKey(e.target.value)} className="font-mono" autoComplete="off" spellCheck={false} type="password" /></Field>
              <Button variant="primary" disabled={!key.trim()} loading={set.isPending} onClick={() => set.mutate()}>Set key</Button>
            </div>
            {(set.error || check.error || remove.error) && !removing && <p role="alert" className="text-compact text-critical mt-2">{errorText(set.error ?? check.error ?? remove.error)}</p>}
            <div className="flex flex-wrap gap-2 mt-4">
              <Button loading={check.isPending} onClick={() => check.mutate()}>Check now</Button>
              {s.keyLast4 && <Button variant="ghost" className="text-critical" onClick={() => setRemoving(true)}>Remove key…</Button>}
              {httpUrl(s.url) && <a href={httpUrl(s.url)!} target="_blank" rel="noreferrer noopener" className="transition-control inline-flex items-center h-10 px-3 rounded-lg text-compact text-ink-2 hover:text-ink hover:bg-surface-2">Proxmox shop</a>}
            </div>
            {removing && <TypedConfirm title="Remove the subscription key?" phrase="remove subscription" action="Remove key" busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onClose={() => setRemoving(false)} onConfirm={() => remove.mutate()}><Notice tone="warning">Without a key this device loses access to the enterprise repository. Updates from it will stop until you set a key again.</Notice></TypedConfirm>}
          </Card>
        );
      }}
    </Async>
  );
}

function PowerBody() {
  const { node, name } = useNodeName();
  const q = useQuery({ queryKey: ["node", "power", name], queryFn: () => nodeApi.power(node), retry: 1 });
  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>Power</SectionTitle>
        <Async q={q}>{(info) => <div className="space-y-4"><PowerCard info={info} /><WakeCard info={info} /></div>}</Async>
      </section>
      <section>
        <SectionTitle>Subscription</SectionTitle>
        <SubscriptionCard />
      </section>
    </div>
  );
}

export function PowerPage() {
  const { name, multi } = useNodeName();
  return (
    <PageFrame width="4xl">
      <PageHeader title="Power and subscription" subtitle={`Restart or turn off ${name}, wake nodes that are off, and manage the Proxmox subscription.`} actions={multi ? <NodeSwitcher /> : undefined} />
      <LiveOnly><PowerBody /></LiveOnly>
    </PageFrame>
  );
}
