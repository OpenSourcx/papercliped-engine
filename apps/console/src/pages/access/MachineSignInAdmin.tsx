import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { host, type IdentityLinkKind, type IdentityLinkView } from "../../data/engine/host.ts";
import { useSession } from "../../auth/session.tsx";
import { Button, Card, Input, Notice } from "../../ui/primitives.tsx";
import { Select } from "../../ui/Select.tsx";

const KEY = ["papercliped", "identity", "admin"];
const who = (p: { userid: string; realm: string }) => `${p.userid}@${p.realm}`;
const when = (ms: number) => new Date(ms).toLocaleString();

/**
 * Administrators of this machine: switch "Sign in with Papercliped" on or off, approve or deny the sign-ins other people asked for,
 * hand out short-lived pre-approvals, and see (and remove) everyone's links. The host service refuses all of this to anyone else,
 * so this card is only shown to administrators.
 */
export function MachineSignInAdmin({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const { session } = useSession();
  const me = session.mode === "live" ? session.user.username : null;
  const oidc = useQuery({ queryKey: [...KEY, "oidc"], queryFn: host.identity.oidc, retry: false });
  const requests = useQuery({ queryKey: [...KEY, "requests"], queryFn: host.identity.requests, refetchInterval: 10_000, retry: false });
  const pre = useQuery({ queryKey: [...KEY, "pre"], queryFn: host.identity.preapprovals, retry: false });
  const all = useQuery({ queryKey: [...KEY, "links"], queryFn: host.identity.links, retry: false });
  const [confirmOff, setConfirmOff] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const toggle = useMutation({ mutationFn: (on: boolean) => (on ? host.identity.oidcEnable() : host.identity.oidcDisable()), onSuccess: () => { setConfirmOff(false); refresh(); void qc.invalidateQueries({ queryKey: ["papercliped", "identity", "links"] }); } });
  const approve = useMutation({ mutationFn: (l: IdentityLinkView) => host.identity.adminApprove(l.linkId, l.account!.id), onSuccess: refresh });
  const deny = useMutation({ mutationFn: (l: IdentityLinkView) => host.identity.adminDeny(l.linkId), onSuccess: refresh });
  const unlink = useMutation({ mutationFn: (id: string) => host.identity.unlink(id), onSuccess: () => { setRemoving(null); refresh(); } });
  const removePre = useMutation({ mutationFn: (id: string) => host.identity.removePreapproval(id), onSuccess: refresh });
  const addPre = useMutation({ mutationFn: (p: Parameters<typeof host.identity.addPreapproval>[0]) => host.identity.addPreapproval(p), onSuccess: refresh });

  const [userid, setUserid] = useState(""), [realm, setRealm] = useState("pam"), [kind, setKind] = useState<IdentityLinkKind>("association"), [bound, setBound] = useState(""), [ttl, setTtl] = useState("24");
  const ttlN = Number(ttl);
  const formOk = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(userid.trim()) && /^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(realm.trim()) && Number.isInteger(ttlN) && ttlN >= 1 && ttlN <= 72 && (bound.trim() === "" || /^[A-Za-z0-9_-]{3,128}$/.test(bound.trim()));
  const err = toggle.error ?? approve.error ?? deny.error ?? unlink.error ?? removePre.error ?? addPre.error ?? requests.error;
  const others = (all.data?.links ?? []).filter((l) => l.state === "active" && (!me || (who(l.principal) !== me && who(l.requestedBy) !== me)));
  const enabled = oidc.data?.enabled === true;

  return <Card className="p-5 space-y-5">
    <div><h2 className="font-medium">Papercliped sign-in: administrators</h2>
      <p className="text-compact text-ink-3">What other people may link on this machine, and who approves it. Nothing here grants a Proxmox permission; a linked person still gets only what you give their Proxmox user.</p></div>
    {err && <Notice tone="warning" title="That did not work">{err instanceof Error ? err.message : "Try again."}</Notice>}

    <section aria-labelledby="msa-realm" className="space-y-2">
      <h3 id="msa-realm" className="text-compact font-medium">Sign in with Papercliped</h3>
      <p className="text-compact text-ink-3">{enabled ? "On: people with a Papercliped account linked to this machine can use it to sign in to the console (a Proxmox login realm called papercliped)." : "Off: nobody can sign in with a Papercliped account. Turning it on adds a Proxmox login realm called papercliped."}</p>
      {canManage && (enabled
        ? confirmOff
          ? <Notice tone="warning" title="Turn off Sign in with Papercliped?" action={<><Button onClick={() => setConfirmOff(false)}>Keep it on</Button><Button variant="danger" loading={toggle.isPending} onClick={() => toggle.mutate(false)}>Turn off</Button></>}>This removes the realm and ends every sign-in link made with it. Linked accounts stay recorded but can no longer sign in.</Notice>
          : <Button variant="ghost" onClick={() => setConfirmOff(true)}>Turn off</Button>
        : <Button variant="primary" loading={toggle.isPending} onClick={() => toggle.mutate(true)}>Turn on</Button>)}
    </section>

    <section aria-labelledby="msa-queue" className="space-y-2">
      <h3 id="msa-queue" className="text-compact font-medium">Waiting for your approval</h3>
      {(requests.data ?? []).length === 0 ? <p className="text-compact text-ink-3">Nothing is waiting. A request appears here after its owner has approved it on link.papercliped.co.</p>
        : (requests.data ?? []).map((l) => <div key={l.linkId} className="rounded-md border border-line px-3 py-2 space-y-2">
          <p className="text-compact"><span className="font-mono">{who(l.requestedBy)}</span> asks to {l.kind === "federated" ? "sign in with" : "link"} Papercliped account <span className="font-mono">{l.account?.id ?? "unknown"}</span>{l.account?.displayName ? ` (${l.account.displayName})` : ""}. Expires {when(l.expiresAt)}.</p>
          <p className="text-xs text-ink-3">Approve only if you know this person and that account. {l.kind === "federated" ? "They will be able to sign in with no permissions until you grant some." : "This only records which account they own."}</p>
          <div className="flex gap-2"><Button variant="primary" disabled={!l.account} loading={approve.isPending && approve.variables?.linkId === l.linkId} onClick={() => approve.mutate(l)}>Approve</Button><Button variant="danger" loading={deny.isPending && deny.variables?.linkId === l.linkId} onClick={() => deny.mutate(l)}>Deny</Button></div>
        </div>)}
    </section>

    <section aria-labelledby="msa-pre" className="space-y-2">
      <h3 id="msa-pre" className="text-compact font-medium">Pre-approvals</h3>
      <p className="text-compact text-ink-3">Let a Proxmox user link without waiting for you. It expires on its own (1 to 72 hours); naming an account id limits it to that one account.</p>
      {(pre.data ?? []).map((p) => <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2">
        <div className="min-w-0 text-compact"><span className="font-mono">{who(p.principal)}</span> may {p.kind === "federated" ? "sign in with" : "link"} {p.boundAccountId ? <>account <span className="font-mono">{p.boundAccountId}</span></> : "any account"} until {when(p.expiresAt)}</div>
        <Button className="ml-auto" variant="ghost" loading={removePre.isPending && removePre.variables === p.id} onClick={() => removePre.mutate(p.id)}>Remove</Button>
      </div>)}
      {canManage && <form className="grid gap-2 sm:grid-cols-6 items-end" onSubmit={(e) => { e.preventDefault(); if (formOk) addPre.mutate({ principal: { userid: userid.trim(), realm: realm.trim() }, kind, ...(bound.trim() ? { boundAccountId: bound.trim() } : {}), ttlHours: ttlN }); }}>
        <label className="text-compact sm:col-span-2">Proxmox user<Input className="mt-1" value={userid} onChange={(e) => setUserid(e.target.value)} placeholder="alice" aria-label="Proxmox user" /></label>
        <label className="text-compact">Realm<Input className="mt-1" value={realm} onChange={(e) => setRealm(e.target.value)} aria-label="Realm" /></label>
        <label className="text-compact">Kind<Select className="mt-1" value={kind} onChange={(e) => setKind(e.target.value as IdentityLinkKind)} aria-label="Kind"><option value="association">Link</option>{enabled && <option value="federated">Sign in</option>}</Select></label>
        <label className="text-compact">Hours<Input className="mt-1" value={ttl} inputMode="numeric" onChange={(e) => setTtl(e.target.value)} aria-label="Hours" /></label>
        <label className="text-compact sm:col-span-4">Only this Papercliped account (optional)<Input className="mt-1 font-mono" value={bound} onChange={(e) => setBound(e.target.value)} aria-label="Account id" /></label>
        <Button type="submit" variant="primary" disabled={!formOk} loading={addPre.isPending} className="sm:col-span-2">Add pre-approval</Button>
      </form>}
    </section>

    {others.length > 0 && <section aria-labelledby="msa-all" className="space-y-2">
      <h3 id="msa-all" className="text-compact font-medium">Other people's links</h3>
      {others.map((l) => <div key={l.linkId} className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2">
        <div className="min-w-0 text-compact"><span className="font-mono">{who(l.principal)}</span> {l.kind === "federated" ? "can sign in with" : "is linked to"} <span className="font-mono">{l.account?.id ?? "unknown"}</span></div>
        <div className="ml-auto flex gap-2">{removing === l.linkId
          ? <><Button onClick={() => setRemoving(null)}>Keep</Button><Button variant="danger" loading={unlink.isPending} onClick={() => unlink.mutate(l.linkId)}>Unlink</Button></>
          : <Button variant="ghost" onClick={() => setRemoving(l.linkId)}>Unlink</Button>}</div>
      </div>)}
    </section>}
  </Card>;
}
