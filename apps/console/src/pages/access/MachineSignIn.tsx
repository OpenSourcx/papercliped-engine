import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { host, type IdentityLinkKind, type IdentityLinkView, type IdentityStartView } from "../../data/engine/host.ts";
import { httpUrl } from "../../lib/safeUrl.ts";
import { useSession } from "../../auth/session.tsx";
import { Button, Card, Notice } from "../../ui/primitives.tsx";

const KEY = ["papercliped", "identity", "links"];
const OPEN = new Set(["starting", "awaiting_account", "awaiting_confirm", "awaiting_admin"]);
const who = (p: { userid: string; realm: string }) => `${p.userid}@${p.realm}`;

/**
 * Access → Remote access: link the Papercliped account of the person using this console to their Proxmox user on this machine.
 * The owner approves on link.papercliped.co with the code shown here; then the administrator confirms the account that approved it.
 * Linking never grants a Proxmox permission.
 */
export function MachineSignIn() {
  const qc = useQueryClient();
  const links = useQuery({ queryKey: KEY, queryFn: host.identity.links, refetchInterval: (q) => (q.state.data?.links.some((l) => OPEN.has(l.state)) ? 3000 : 30_000) });
  const oidc = useQuery({ queryKey: [...KEY, "oidc"], queryFn: host.identity.oidc, retry: false });
  // The code is returned once, when the link starts; it is kept here for as long as this page is open.
  const [started, setStarted] = useState<IdentityStartView | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const start = useMutation({ mutationFn: (kind: IdentityLinkKind) => host.identity.start(kind), onSuccess: (v) => { setStarted(v); refresh(); } });
  const confirm = useMutation({ mutationFn: (l: IdentityLinkView) => host.identity.confirm(l.linkId, l.account!.id), onSuccess: () => { setStarted(null); refresh(); } });
  const cancel = useMutation({ mutationFn: (id: string) => host.identity.cancel(id), onSuccess: () => { setStarted(null); refresh(); } });
  const unlink = useMutation({ mutationFn: (id: string) => host.identity.unlink(id), onSuccess: () => { setRemoving(null); refresh(); } });

  const { session } = useSession();
  const me = session.mode === "live" ? session.user.username : null;
  // An administrator's list holds everyone's links (the administrator section below shows those); this card is about the person using the console.
  const mine = (links.data?.links ?? []).filter((l) => !me || who(l.principal) === me || who(l.requestedBy) === me);
  const open = mine.find((l) => OPEN.has(l.state));
  const active = mine.filter((l) => l.state === "active");
  // While the owner has not approved yet, ask Connect (the host does) so the state moves on by itself.
  const poll = useQuery({ queryKey: [...KEY, "poll", open?.linkId], queryFn: () => host.identity.poll(open!.linkId), enabled: open?.state === "awaiting_account", refetchInterval: 3000, retry: false });
  useEffect(() => { if (poll.data && poll.data.state !== "awaiting_account") refresh(); }, [poll.data?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const err = start.error ?? confirm.error ?? cancel.error ?? unlink.error ?? links.error;
  const code = started && open && started.linkId === open.linkId ? started : null;
  const portal = code?.linkUrl ? httpUrl(code.linkUrl) : null;

  return <Card className="p-5 space-y-4">
    <h2 className="font-medium">Sign in with your Papercliped account</h2>
    <p className="text-compact text-ink-3">Link your Papercliped account to your Proxmox user on this machine. It does not sign anyone in by itself and never changes a Proxmox permission.</p>
    {err && <Notice tone="warning" title="That did not work">{err instanceof Error ? err.message : "Try again."}</Notice>}
    {active.map((l) => <div key={l.linkId} className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2">
      <div className="min-w-0 text-compact"><span className="font-mono">{who(l.principal)}</span> {l.kind === "federated" ? "can sign in with" : "is linked to"} Papercliped account <span className="font-mono">{l.account?.id ?? "unknown"}</span></div>
      <div className="ml-auto flex gap-2">{removing === l.linkId
        ? <><Button onClick={() => setRemoving(null)}>Keep</Button><Button variant="danger" loading={unlink.isPending} onClick={() => unlink.mutate(l.linkId)}>Unlink</Button></>
        : <Button variant="ghost" onClick={() => setRemoving(l.linkId)}>Unlink</Button>}</div>
    </div>)}
    {!open ? <div className="flex flex-wrap gap-2">
      <Button variant="primary" loading={start.isPending && start.variables === "association"} onClick={() => start.mutate("association")}>Link my Papercliped account</Button>
      {oidc.data?.enabled && !active.some((l) => l.kind === "federated") && <Button loading={start.isPending && start.variables === "federated"} onClick={() => start.mutate("federated")}>Let me sign in with Papercliped</Button>}
    </div> : open.state === "awaiting_account" || open.state === "starting" ? <div className="space-y-3">
      {code ? <ol className="list-decimal pl-5 space-y-2 text-compact text-ink-2">
        <li>Open {portal ? <a className="inline-flex items-center gap-1 text-accent hover:underline" href={portal} target="_blank" rel="noopener noreferrer">link.papercliped.co<ExternalLink className="h-3.5 w-3.5" /></a> : "link.papercliped.co"} and sign in with your Papercliped account.</li>
        <li>Enter this code:
          <div className="mt-2 inline-block rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-lg tracking-widest text-ink" aria-label={`Link code ${code.userCode.split("").join(" ")}`}>{code.userCode}</div></li>
        <li>Approve it there. This page updates by itself, then asks you to confirm the account.</li>
      </ol> : <Notice tone="info" title="Waiting for approval">A request is waiting, but its code was only shown when it started. Cancel it and start again to get a new code.</Notice>}
      <Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(open.linkId)}>Cancel</Button>
    </div> : open.state === "awaiting_confirm" && open.account ? <div className="space-y-3">
      <Notice tone="info" title="Approved by Papercliped account">The account id is <span className="font-mono">{open.account.id}</span>. Confirm only if that is your account. Confirming links it to <span className="font-mono">{who(open.principal)}</span>; it does not change any Proxmox permission.</Notice>
      <div className="flex gap-2"><Button variant="primary" loading={confirm.isPending} onClick={() => confirm.mutate(open)}>Confirm this account</Button><Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(open.linkId)}>Cancel</Button></div>
    </div> : <div className="space-y-3">
      <Notice tone="info" title="Waiting for a Proxmox administrator">The account is confirmed. An administrator of this machine has to approve this sign-in before it works.</Notice>
      <Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(open.linkId)}>Cancel</Button>
    </div>}
  </Card>;
}
