import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useSession } from "../../auth/session.tsx";
import { access, type Acl } from "../../data/engine/access.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Input } from "../../ui/primitives.tsx";
import { AddAclModal } from "./RolesTab.tsx";

const KEY = ["access", "acl"] as const;
const subjectLabel = (a: Acl) => (a.type === "group" ? `Group ${a.ugid}` : a.type === "token" ? `Token ${a.ugid}` : a.ugid);

/**
 * Who may use one thing (a storage, a resource group), as Proxmox permissions on its path: list, grant and revoke. These
 * are the ordinary ACLs of Roles & permissions, shown where the thing is; Proxmox decides whether you may change them.
 */
export function PathPermissions({ path, noun }: { path: string; noun: string }) {
  const qc = useQueryClient();
  const aclQ = useQuery({ queryKey: KEY, queryFn: access.acl.list, retry: 0 });
  const rolesQ = useQuery({ queryKey: ["access", "roles"], queryFn: access.roles.list, retry: 0 });
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<Acl | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mine = (aclQ.data?.acls ?? []).filter((a) => a.path === path);
  const revoke = useMutation({
    mutationFn: (a: Acl) => access.acl.set({ path: a.path, roles: [a.roleid], [a.type === "user" ? "users" : a.type === "group" ? "groups" : "tokens"]: [a.ugid], remove: true }),
    onSuccess: () => {
      setRevoking(null);
      setTyped("");
      qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => setError(errorText(e)),
  });
  const can = aclQ.data?.canModify === true;
  return (
    <section aria-label={`Who can use ${noun}`}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <h2 className="text-compact font-semibold uppercase tracking-label text-ink-3 flex items-center gap-2"><ShieldCheck className="h-4 w-4" aria-hidden />Who can use this {noun}</h2>
        {can && rolesQ.data && <Button size="sm" onClick={() => setAdding(true)}><Plus className="h-4 w-4" />Grant access</Button>}
      </div>
      <p className="text-xs text-ink-3 mb-2">Permissions on <span className="font-mono">{path}</span>. Anyone with a role on a path above it (for example the whole device) has it here too; see Access control for the full picture.</p>
      {aclQ.isPending ? <p className="text-compact text-ink-3">Reading from Proxmox…</p> : aclQ.error ? <p role="alert" className="text-compact text-critical">{errorText(aclQ.error)}</p> : mine.length === 0 ? <p className="text-compact text-ink-3">Nothing is granted on this {noun} itself.</p> : (
        <ul className="rounded-lg border border-line divide-y divide-line">
          {mine.map((a) => (
            <li key={`${a.type}${a.ugid}${a.roleid}`} className="flex items-center gap-3 px-3 py-2">
              <span className="flex-1 min-w-0 truncate text-compact">{subjectLabel(a)}</span>
              <Chip tone="accent">{a.roleid}</Chip>
              {!a.propagate && <Chip>This {noun} only</Chip>}
              {can && <Button size="sm" variant="ghost" aria-label={`Revoke ${a.roleid} from ${a.ugid}`} onClick={() => { setError(null); setRevoking(a); }}><Trash2 className="h-4 w-4" /></Button>}
            </li>
          ))}
        </ul>
      )}
      {error && !revoking && <p role="alert" className="text-compact text-critical mt-2">{error}</p>}
      {adding && rolesQ.data && <AddAclModal roles={rolesQ.data.roles} initial={{ path }} onClose={() => setAdding(false)} />}
      {revoking && (
        <Modal size="sm" title="Take this access away?" subtitle={`${subjectLabel(revoking)} loses ${revoking.roleid} on ${revoking.path}. Type the role's name to confirm.`} onClose={() => { setRevoking(null); setTyped(""); }}
          footer={<><Button variant="ghost" onClick={() => { setRevoking(null); setTyped(""); }}>Cancel</Button><Button variant="danger" loading={revoke.isPending} disabled={typed !== revoking.roleid} onClick={() => revoke.mutate(revoking)}>Revoke</Button></>}>
          <div className="space-y-3">
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={`Type ${revoking.roleid}`} className="font-mono" spellCheck={false} aria-label="Type the role to confirm" autoFocus />
            {error && <p role="alert" className="text-compact text-critical">{error}</p>}
          </div>
        </Modal>
      )}
    </section>
  );
}

/** The same, only on a live device (the demo has no Proxmox to ask). */
export function LivePathPermissions(props: { path: string; noun: string }) {
  const { session } = useSession();
  return session.mode === "live" ? <Card className="p-5 mb-5"><PathPermissions {...props} /></Card> : null;
}
