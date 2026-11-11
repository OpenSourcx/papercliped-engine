import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Loader2, LogIn, UserPlus, Wrench } from "lucide-react";
import { iac, type IacOverview, type OrgRole } from "../../data/engine/host.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Button, Card, Chip, Notice, Select } from "../../ui/primitives.tsx";
import { IAC_KEY, useMe } from "./shared.tsx";

const DRIFT_KEY = ["iac", "drift"] as const;
const ROLES: OrgRole[] = ["viewer", "operator", "admin", "owner"];

/**
 * Organizations on this device, for a Proxmox administrator. An administrator is an engine instance admin, but that
 * is not membership: they can see every organization and open only the ones they belong to. Here they join one, or
 * give another Proxmox user a role in it, and see where Proxmox and the engine disagree.
 */
export function OrgAccess({ overview }: { overview: IacOverview }) {
  const me = useMe();
  const qc = useQueryClient();
  const [grantFor, setGrantFor] = useState<string | null>(null);
  const [who, setWho] = useState("");
  const [role, setRole] = useState<OrgRole>("viewer");
  const [message, setMessage] = useState<string | null>(null);
  const drift = useQuery({ queryKey: DRIFT_KEY, queryFn: iac.drift, retry: false, enabled: overview.admin === true });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: IAC_KEY });
    void qc.invalidateQueries({ queryKey: DRIFT_KEY });
    void qc.invalidateQueries({ queryKey: ["orgs"] });
  };
  const join = useMutation({
    mutationFn: (v: { companyId: string; userid?: string; role?: OrgRole }) => iac.joinOrg(v.companyId, { userid: v.userid, role: v.role }),
    onSuccess: (r) => {
      setMessage(r.joined ? `${r.userid} now has the ${r.role} role.` : `${r.userid} was already a member.`);
      setGrantFor(null);
      refresh();
    },
    onError: (e) => setMessage(errorText(e)),
  });
  const repair = useMutation({
    mutationFn: (removeStale: boolean) => iac.repairDrift(removeStale),
    onSuccess: (r) => {
      setMessage(`${r.repaired} repaired${r.results.some((x) => !x.done) ? `; ${r.results.filter((x) => !x.done).length} still need attention` : ""}.`);
      refresh();
    },
    onError: (e) => setMessage(errorText(e)),
  });
  if (overview.admin !== true) return null;
  const mine = overview.users.find((u) => u.userid === me);
  const items = drift.data?.items ?? [];
  const syncErrors = Object.values(drift.data?.sync ?? {}).filter((s) => s.errors.length);

  return (
    <section aria-labelledby="org-access-title" className="mb-6">
      <h2 id="org-access-title" className="text-lg font-semibold mb-1">Organizations on this device</h2>
      <p className="text-compact text-ink-3 mb-3">As a Proxmox administrator you can see every organization, but you open only the ones you belong to. Join one to open it, or give someone else a role in it.</p>
      {message && <Notice className="mb-3">{message}</Notice>}
      {overview.orgs.length === 0 ? (
        <p className="text-compact text-ink-3">There are no organizations yet.</p>
      ) : (
        <Card className="divide-y divide-line">
          {overview.orgs.map((o) => {
            const role0 = mine?.orgs.find((x) => x.companyId === o.companyId)?.role;
            const busy = join.isPending && join.variables?.companyId === o.companyId;
            return (
              <div key={o.companyId} className="px-4 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                  <div className="min-w-0 flex-1 flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-ink-3 shrink-0" aria-hidden />
                    <div className="min-w-0"><div className="text-sm font-medium truncate">{o.name}</div><div className="text-xs text-ink-3 font-mono truncate">{o.pool ? `pool ${o.pool}` : "no resource group yet"}</div></div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {role0 ? <Chip tone="good">You: {role0}</Chip> : <Chip tone="warning">Not a member</Chip>}
                    {!role0 && <Button size="sm" variant="primary" disabled={join.isPending} onClick={() => join.mutate({ companyId: o.companyId })} aria-label={`Join ${o.name} as admin`}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}Join as admin</Button>}
                    <Button size="sm" onClick={() => { setGrantFor(grantFor === o.companyId ? null : o.companyId); setWho(""); }} aria-expanded={grantFor === o.companyId} aria-label={`Grant access to ${o.name}`}><UserPlus className="h-4 w-4" />Grant access</Button>
                  </div>
                </div>
                {grantFor === o.companyId && (
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <Select value={who} onChange={(e) => setWho(e.target.value)} aria-label={`Proxmox user to grant ${o.name}`} className="sm:!w-56"><option value="">Choose a user</option>{overview.users.map((u) => <option key={u.userid} value={u.userid}>{u.userid}</option>)}</Select>
                    <Select value={role} onChange={(e) => setRole(e.target.value as OrgRole)} aria-label="Role" className="sm:!w-40">{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</Select>
                    <Button variant="primary" size="sm" disabled={!who || join.isPending} onClick={() => join.mutate({ companyId: o.companyId, userid: who, role })}>Grant</Button>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}
      {(items.length > 0 || syncErrors.length > 0) && (
        <Notice tone="warning" className="mt-3" title="Proxmox and the engine are out of step">
          <ul className="list-disc pl-5 space-y-1">
            {items.slice(0, 8).map((i, n) => <li key={n}>{i.detail}</li>)}
            {items.length > 8 && <li>and {items.length - 8} more</li>}
            {syncErrors.map((s) => <li key={s.name}>{s.errors[0]}</li>)}
          </ul>
          {items.some((i) => i.repair) && (
            <div className="flex flex-wrap gap-2 mt-3">
              <Button size="sm" variant="primary" disabled={repair.isPending} onClick={() => repair.mutate(false)}>{repair.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}Repair</Button>
              {items.some((i) => i.kind === "stale-acl") && <Button size="sm" disabled={repair.isPending} onClick={() => repair.mutate(true)}>Repair and remove stale grants</Button>}
            </div>
          )}
        </Notice>
      )}
    </section>
  );
}
