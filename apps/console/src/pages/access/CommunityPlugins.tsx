import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { connectApi } from "../../data/engine/connectApi.ts";
import { NodeApiError } from "../../data/engine/nodeApi.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Notice, PageFrame, PageHeader, Status, Toggle } from "../../ui/primitives.tsx";

const KEY = ["connect", "plugins"];
const ActionError2 = ({ error }: { error: unknown }) => (error ? <span role="alert" className="mt-2 block text-compact text-critical">{error instanceof Error ? error.message : "That did not work."}</span> : null);
const errorText = (e: unknown) => (e instanceof Error ? e.message : "The device did not answer.");

/** Settings → Community plugins: machine-wide, device administrators only. Install, upgrade and revoke are checked by the host, not here. */
export function CommunityPlugins() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: KEY, queryFn: connectApi.plugins });
  const done = () => void qc.invalidateQueries({ queryKey: KEY });
  const [review, setReview] = useState<{ id: string; name: string; version: string; permissions: string[]; upgrade: boolean } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [revoking, setRevoking] = useState<{ id: string; label: string } | null>(null);
  const close = () => { setReview(null); setAccepted(false); };
  const apply = useMutation({ mutationFn: (r: NonNullable<typeof review>): Promise<unknown> => (r.upgrade ? connectApi.upgradePlugin(r.id, r.permissions) : connectApi.installPlugin(r.id, r.permissions)), onSuccess: () => { close(); done(); } });
  const reinstall = useMutation({ mutationFn: (r: NonNullable<typeof review>) => connectApi.reinstallPlugin(r.id, r.permissions), onSuccess: () => { close(); done(); } });
  const toggle = useMutation({ mutationFn: (v: { id: string; enabled: boolean }) => connectApi.setPlugin(v.id, v.enabled), onSuccess: done });
  const revoke = useMutation({ mutationFn: (id: string) => connectApi.revokePlugin(id), onSuccess: () => { setRevoking(null); done(); } });
  const data = list.data;
  return <PageFrame width="4xl">
    <PageHeader title="Community plugins" subtitle="Machine-wide add-ons that run inside the engine. Only a Proxmox administrator can install, upgrade or revoke them." />
    {list.error && <Notice tone="warning" title="Could not load plugins" action={<Button onClick={() => void list.refetch()}>Retry</Button>}>{errorText(list.error)}</Notice>}
    {data && !data.catalog.trusted && <Notice tone="info" title="No trusted catalog on this device">Nothing can be installed from a catalog until a catalog signing key is pinned on this device. Plugins the engine already has are listed and can be revoked.</Notice>}
    {data?.catalog.problem && <Notice tone="warning" title="The catalog was not used">{data.catalog.problem.message}</Notice>}
    {data && !data.engine.ok && <Notice tone="warning" title="Engine not reachable">{data.engine.problem}</Notice>}
    {data && <p className="text-compact text-ink-3">{data.note}</p>}
    <div className="mt-4 space-y-3">
      {data?.plugins.map((p) => <Card key={p.id} className="p-4"><div className="flex flex-wrap items-center gap-3">
        {p.verified ? <ShieldCheck className="h-5 w-5 text-good shrink-0" aria-hidden /> : <ShieldAlert className="h-5 w-5 text-warning shrink-0" aria-hidden />}
        <div className="min-w-0 flex-1 basis-48"><div className="truncate font-medium">{p.packageName ?? p.key ?? p.id}{p.version ? ` ${p.version}` : ""}</div>
          <div className="text-xs text-ink-3">{p.verified ? `From the signed catalog. Permissions you accepted: ${p.grantedPermissions?.join(", ") || "none"}` : "Not from the signed catalog. It can be switched off or revoked, never switched on from here."}</div></div>
        <Status kind={p.status === "ready" ? "good" : "warning"} label={p.status ?? "unknown"} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {data.updates.filter((u) => u.id === p.catalogId).map((u) => <Button key={u.to} size="sm" variant="primary" onClick={() => setReview({ id: u.id, name: p.packageName ?? u.id, version: u.to, permissions: u.permissions, upgrade: true })}>Review upgrade to {u.to}{u.needsConsent ? " (new permissions)" : ""}</Button>)}
        {(p.verified || p.status === "ready") && <Button loading={toggle.isPending} onClick={() => toggle.mutate({ id: p.catalogId ?? p.id, enabled: p.status !== "ready" })} disabled={p.status !== "ready" && !p.verified}>{p.status === "ready" ? "Switch off" : "Switch on"}</Button>}
        <Button variant="ghost" onClick={() => setRevoking({ id: p.catalogId ?? p.id, label: p.packageName ?? p.key ?? p.id })}>Revoke</Button>
      </div></Card>)}
      {data?.plugins.length === 0 && <Card className="p-4 text-compact text-ink-3">No plugins are installed in the engine.</Card>}
    </div>
    {data && data.available.length > 0 && <><h2 className="mt-6 mb-2 font-medium">Available from the signed catalog</h2><div className="space-y-3">{data.available.map((a) => <Card key={a.id} className="p-4"><div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1 basis-48"><div className="font-medium">{a.name} <span className="text-ink-3 font-normal">{a.version} · {a.vendor}</span></div><div className="text-xs text-ink-3">{a.summary}</div></div><Button variant="primary" onClick={() => setReview({ id: a.id, name: a.name, version: a.version, permissions: a.permissions, upgrade: false })}>Review and install</Button></div></Card>)}</div></>}
    {review && <Modal title={`${review.upgrade ? "Upgrade" : "Install"} ${review.name} ${review.version}`} onClose={close} footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" disabled={!accepted} loading={apply.isPending} onClick={() => apply.mutate(review)}>{review.upgrade ? "Upgrade" : "Install"}</Button></>}>
      <div className="space-y-3"><p className="text-sm text-ink-2">This plugin declares that it needs:</p>
        <ul className="list-disc pl-5 text-compact font-mono">{review.permissions.length ? review.permissions.map((p) => <li key={p}>{p}</li>) : <li className="font-sans">No permissions declared.</li>}</ul>
        <p className="text-xs text-ink-3">These are the publisher’s declarations, shown from the signed catalog. The device checks that the package is exactly the one the catalog was signed for, and records what you accepted.</p>
        <Toggle label="I have reviewed these permissions and accept them" checked={accepted} onChange={setAccepted} />
        {apply.error && !(apply.error instanceof NodeApiError && apply.error.code === "capability_increase") && <p role="alert" className="text-compact text-critical">{errorText(apply.error)}</p>}
        {apply.error instanceof NodeApiError && apply.error.code === "capability_increase" && <Notice tone="warning" title="The engine won’t upgrade this in place" action={<Button variant="danger" loading={reinstall.isPending} onClick={() => reinstall.mutate(review)}>Revoke and install {review.version}</Button>}>{apply.error.message} Reinstalling removes the plugin from the engine and installs {review.version}; the permissions listed above are the publisher’s declarations, not an enforced sandbox. If the install fails the previous version is put back.<ActionError2 error={reinstall.error} /></Notice>}</div></Modal>}
    {revoking && <Modal title={`Revoke ${revoking.label}?`} onClose={() => setRevoking(null)} footer={<><Button onClick={() => setRevoking(null)}>Cancel</Button><Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate(revoking.id)}>Revoke and remove</Button></>}>
      <p className="text-sm text-ink-2">The plugin is removed from the engine and the permissions you accepted are forgotten. Work that depends on it may fail.</p>{revoke.error && <p role="alert" className="mt-2 text-compact text-critical">{errorText(revoke.error)}</p>}</Modal>}
  </PageFrame>;
}
