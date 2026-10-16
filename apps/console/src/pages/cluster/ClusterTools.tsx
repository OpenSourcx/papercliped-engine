import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { clusterMoreApi } from "../../data/engine/w3Api.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Field, Input, Notice, Select, Status, Toggle } from "../../ui/primitives.tsx";
import { Async, TaskModal } from "../node/common.tsx";
import { Guide, numOrUndef } from "../disks/w3Common.tsx";

/** The quorum device and corosync links: read here, changed with the commands this card builds. */
export function QdeviceCard() {
  const q = useQuery({ queryKey: ["cluster", "qdevice"], queryFn: clusterMoreApi.qdevice, retry: 0 });
  const [open, setOpen] = useState<"setup" | "remove" | "link" | "votes" | null>(null);
  return (
    <Card className="p-5 space-y-3">
      <div className="font-medium">Quorum device and links</div>
      <Async q={q}>
        {(d) => (
          <>
            <div className="flex items-center gap-2">{d.configured ? <Status kind="good" label="Quorum device set up" /> : <Status kind="idle" label="No quorum device" />}<span className="text-compact text-ink-3">{d.nodes} node{d.nodes === 1 ? "" : "s"}</span></div>
            <p className="text-compact text-ink-2">{d.recommendation}</p>
            <div className="flex gap-2 flex-wrap">
              {d.configured ? <Button size="sm" variant="ghost" onClick={() => setOpen("remove")}>Remove it…</Button> : <Button size="sm" onClick={() => setOpen("setup")}>Set one up…</Button>}
              <Button size="sm" variant="ghost" onClick={() => setOpen("link")}>Add or change a link…</Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen("votes")}>Lost quorum…</Button>
            </div>
            <p className="text-xs text-ink-3">Proxmox has no API for these, so you get exact commands to run on a node, checked and ready to copy.</p>
          </>
        )}
      </Async>
      {open === "setup" && <QdeviceSetup onClose={() => setOpen(null)} />}
      {open === "remove" && <GuideModal title="Remove the quorum device" fetcher={() => clusterMoreApi.qdeviceGuide("remove")} keyName="q-remove" onClose={() => setOpen(null)} />}
      {open === "link" && <LinkGuide onClose={() => setOpen(null)} />}
      {open === "votes" && <GuideModal title="A node lost quorum" fetcher={() => clusterMoreApi.corosyncGuide("expected-votes")} keyName="c-votes" onClose={() => setOpen(null)} />}
    </Card>
  );
}

function GuideModal({ title, fetcher, keyName, onClose }: { title: string; fetcher: () => ReturnType<typeof clusterMoreApi.qdeviceGuide>; keyName: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["cluster", "guide", keyName], queryFn: fetcher, retry: 0 });
  return <Modal title={title} size="lg" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}><Async q={q}>{(g) => <Guide steps={g.steps} cautions={g.cautions} />}</Async></Modal>;
}

function QdeviceSetup({ onClose }: { onClose: () => void }) {
  const [address, setAddress] = useState("");
  const [go, setGo] = useState("");
  const q = useQuery({ queryKey: ["cluster", "guide", "q-setup", go], queryFn: () => clusterMoreApi.qdeviceGuide("setup", go), enabled: !!go, retry: 0 });
  return (
    <Modal title="Set up a quorum device" subtitle="A small outside machine that casts a tie-breaking vote" size="lg" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="space-y-4">
        <div className="flex gap-2 items-end"><Field label="Address of the outside machine" htmlFor="qd-addr" className="flex-1"><Input id="qd-addr" value={address} onChange={(e) => setAddress(e.target.value)} className="font-mono" placeholder="10.0.0.9" spellCheck={false} /></Field><Button disabled={!address} onClick={() => setGo(address)}>Show the steps</Button></div>
        {q.error && <Notice tone="critical">{errorText(q.error)}</Notice>}
        {q.data && <Guide steps={q.data.steps} cautions={q.data.cautions} />}
      </div>
    </Modal>
  );
}

function LinkGuide({ onClose }: { onClose: () => void }) {
  const [action, setAction] = useState("add-link");
  const [address, setAddress] = useState("");
  const [link, setLink] = useState("1");
  const [node, setNode] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["cluster", "guide", "link", asked], queryFn: () => clusterMoreApi.corosyncGuide(action, { address, link: numOrUndef(link), node: node || undefined }), enabled: asked !== null, retry: 0 });
  return (
    <Modal title="Add or change a cluster link" subtitle="Corosync's network links" size="lg" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="space-y-4">
        <div className="grid sm:grid-cols-4 gap-3">
          <Field label="Do" htmlFor="cl-act"><Select id="cl-act" value={action} onChange={(e) => setAction(e.target.value)}><option value="add-link">Add a link</option><option value="change-link">Change an address</option></Select></Field>
          <Field label="Link number" htmlFor="cl-n"><Input id="cl-n" type="number" min={0} max={7} value={link} onChange={(e) => setLink(e.target.value)} className="tabular-nums" /></Field>
          <Field label="Node" htmlFor="cl-node"><Input id="cl-node" value={node} onChange={(e) => setNode(e.target.value)} className="font-mono" /></Field>
          <Field label="Address" htmlFor="cl-addr"><Input id="cl-addr" value={address} onChange={(e) => setAddress(e.target.value)} className="font-mono" spellCheck={false} /></Field>
        </div>
        <Button disabled={!address} onClick={() => setAsked(`${action}|${address}|${link}|${node}`)}>Show the steps</Button>
        {q.error && <Notice tone="critical">{errorText(q.error)}</Notice>}
        {q.data && <Guide steps={q.data.steps} cautions={q.data.cautions} />}
      </div>
    </Modal>
  );
}

/** Adding and removing nodes, in the order that keeps a cluster healthy. */
export function NodeLifecycleGuide() {
  const [open, setOpen] = useState(false);
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap"><div className="font-medium">Adding and removing nodes</div><Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show the steps"}</Button></div>
      {open && (
        <div className="grid md:grid-cols-2 gap-6 mt-3 text-compact">
          <div>
            <div className="font-medium mb-1.5">Adding a node</div>
            <ol className="list-decimal pl-5 space-y-1.5 text-ink-2">
              <li>Install the same Proxmox version on the new machine. Give it its own name and address; names can't be reused or changed later.</li>
              <li>Keep it empty. A node with machines of its own can't join, because their numbers could clash.</li>
              <li>Check the clock is right and that the nodes reach each other on the cluster network (UDP 5405 and 5406, TCP 22 and 8006).</li>
              <li>Here, open Join information and copy it. On the new machine, open this screen, choose Join a cluster and paste it.</li>
              <li>Enter the root password of this node once. The new node appears in the list when it has joined and its sign-in is refreshed.</li>
              <li>Add a second link on another network if you can, so one broken cable doesn't split the cluster.</li>
            </ol>
          </div>
          <div>
            <div className="font-medium mb-1.5">Removing a node</div>
            <ol className="list-decimal pl-5 space-y-1.5 text-ink-2">
              <li>Move its machines elsewhere with Migrate, and take it out of HA rules and replication jobs.</li>
              <li>With three or fewer nodes, think about quorum first: two of three must stay online.</li>
              <li>Shut the node down and keep it off. Reinstall it before using it again, or it will rejoin with its old identity.</li>
              <li>Press Remove next to the node here and type its name. The dialog lists what is still tied to it.</li>
              <li>Afterwards, delete its leftover folder under /etc/pve/nodes/ if you want the name free again.</li>
            </ol>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Move a machine to a different cluster (Proxmox marks this experimental). The other cluster's API token is typed once and never kept. */
export function RemoteMigrateButton({ vmid }: { vmid: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><Globe className="h-3.5 w-3.5" />Move to another cluster…</Button>
      {open && <RemoteMigrateModal vmid={vmid} onClose={() => setOpen(false)} />}
    </>
  );
}

function RemoteMigrateModal({ vmid, onClose }: { vmid: number; onClose: () => void }) {
  const info = useQuery({ queryKey: ["cluster", "remote-info", vmid], queryFn: () => clusterMoreApi.remoteInfo(vmid), retry: 0 });
  return (
    <Modal title="Move to another cluster" subtitle={`Machine ${vmid}`} size="lg" onClose={onClose}>
      <Async q={info}>{(i) => <RemoteForm i={i} onClose={onClose} />}</Async>
    </Modal>
  );
}

function RemoteForm({ i, onClose }: { i: import("../../data/engine/w3Api.ts").RemoteMigrateInfo; onClose: () => void }) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [secret, setSecret] = useState("");
  const [storage, setStorage] = useState(i.storages.join(",").length ? i.storages[0] : "");
  const [bridge, setBridge] = useState(i.bridges[0] ?? "vmbr0");
  const [targetVmid, setTargetVmid] = useState("");
  const [online, setOnline] = useState(i.running);
  const [del, setDel] = useState(false);
  const [typed, setTyped] = useState("");
  const [typedDel, setTypedDel] = useState("");
  const go = useMutation({ mutationFn: () => clusterMoreApi.remoteMigrate(i.vmid, { host, port: numOrUndef(port), fingerprint, tokenId, tokenSecret: secret, targetStorage: storage, targetBridge: bridge, targetVmid: numOrUndef(targetVmid), online: i.running ? online : undefined, delete: del || undefined, confirm: typed, confirmDelete: del ? typedDel : undefined }) });
  const [upid, setUpid] = useState<string | null>(null);
  if (upid) return <TaskModal upid={upid} title="Move to another cluster" onClose={onClose} />;
  return (
    <div className="space-y-4">
      <Notice tone="warning" title="Experimental in Proxmox">The machine is copied to another cluster over the network. By default the original stays here, stopped. Keep a backup first.</Notice>
      {i.blockers.map((b) => <Notice key={b} tone="critical">{b}</Notice>)}
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Other cluster's address" htmlFor="rm-host" className="sm:col-span-2"><Input id="rm-host" value={host} onChange={(e) => setHost(e.target.value)} className="font-mono" spellCheck={false} /></Field>
        <Field label="Port (optional)" htmlFor="rm-port"><Input id="rm-port" type="number" value={port} onChange={(e) => setPort(e.target.value)} className="tabular-nums" /></Field>
      </div>
      <Field label="Its certificate fingerprint" hint="From the other cluster: Datacenter, Certificates, or pvecm status. Checked so nothing can pose as it." htmlFor="rm-fp"><Input id="rm-fp" value={fingerprint} onChange={(e) => setFingerprint(e.target.value)} className="font-mono text-xs" spellCheck={false} /></Field>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="API token ID" hint="user@realm!name, with VM.Allocate there" htmlFor="rm-tid"><Input id="rm-tid" value={tokenId} onChange={(e) => setTokenId(e.target.value)} className="font-mono" spellCheck={false} /></Field>
        <Field label="Token secret" hint="Used once and never kept" htmlFor="rm-sec"><Input id="rm-sec" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" className="font-mono" /></Field>
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Storage over there" hint={i.storages.length ? `Here it uses ${i.storages.join(", ")}` : undefined} htmlFor="rm-st"><Input id="rm-st" value={storage} onChange={(e) => setStorage(e.target.value)} className="font-mono" /></Field>
        <Field label="Bridge over there" hint={i.bridges.length ? `Here: ${i.bridges.join(", ")}` : undefined} htmlFor="rm-br"><Input id="rm-br" value={bridge} onChange={(e) => setBridge(e.target.value)} className="font-mono" /></Field>
        <Field label="New number (optional)" htmlFor="rm-vm"><Input id="rm-vm" type="number" value={targetVmid} onChange={(e) => setTargetVmid(e.target.value)} className="tabular-nums" /></Field>
      </div>
      {i.running && <div className="flex items-center gap-3"><Toggle checked={online} onChange={setOnline} label="Live" /><span className="text-compact">Keep it running while it moves</span></div>}
      <div className="flex items-center gap-3"><Toggle checked={del} onChange={setDel} label="Delete the original" /><span className="text-compact">Delete the original here afterwards</span></div>
      {del && <Field label={<>Type <span className="font-mono text-ink">delete</span> to allow it</>} htmlFor="rm-del"><Input id="rm-del" value={typedDel} onChange={(e) => setTypedDel(e.target.value)} className="font-mono w-40" /></Field>}
      <Field label={<>Type <span className="font-mono text-ink">{i.vmid}</span> to confirm</>} htmlFor="rm-typed"><Input id="rm-typed" value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono w-40" autoComplete="off" /></Field>
      {go.error && <p role="alert" className="text-compact text-critical">{errorText(go.error)}</p>}
      <div className="flex justify-end gap-2"><Chip>{i.type === "lxc" ? "container" : "virtual machine"}</Chip><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={i.blockers.length > 0 || !host || !fingerprint || !tokenId || !secret || !storage || !bridge || typed !== String(i.vmid) || (del && typedDel !== "delete")} loading={go.isPending} onClick={() => go.mutate(undefined, { onSuccess: (r) => { setSecret(""); setUpid(r.task); } })}>Move</Button></div>
    </div>
  );
}
