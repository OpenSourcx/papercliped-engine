import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { access, type EpcToken, type PveToken } from "../../data/engine/access.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Chip, EmptyState, Field, Input, Notice, SectionTitle, Select, Toggle } from "../../ui/primitives.tsx";
import { AddAclModal } from "./RolesTab.tsx";
import { QueryState, SecretOnce, Table, Td, Th, dateOf, dateOfMs, useIac, useMe } from "./shared.tsx";

const EPC_KEY = ["access", "epc-tokens"] as const;

const PRIVSEP_HELP =
  "Privilege separation: the token has no permissions of its own. It can only do what you grant it on the Roles & permissions tab, however powerful you are. Without it, the token acts as the user with all of their permissions. Separated tokens are safer for automation.";

function curlExample(token: string) {
  return `curl -H "Authorization: Bearer ${token}" ${window.location.origin}/api/host`;
}

function CreateEpcToken({ maxDays, defaultDays, onClose, onCreated }: { maxDays: number; defaultDays: number; onClose: () => void; onCreated: (t: { token: string; record: EpcToken; note: string }) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [days, setDays] = useState(defaultDays);
  const [readOnly, setReadOnly] = useState(false);
  const [privsep, setPrivsep] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => access.epcTokens.create({ name: name.trim(), expiresInDays: days, readOnly, privsep }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: EPC_KEY });
      onCreated(r);
    },
    onError: (e) => setError(errorText(e)),
  });
  const options = [7, 30, 90, 180, maxDays].filter((v, i, a) => v <= maxDays && a.indexOf(v) === i);
  return (
    <Modal size="md" icon={<KeyRound className="h-5 w-5" />} title="New ePaperclip API token" subtitle="For scripts and automation. It acts as you, through a Proxmox API token that Proxmox can revoke too." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>Create token</Button></>}>
      <div className="space-y-4">
        <Field label="Name" hint="What it is for, for example nightly report."><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus /></Field>
        <Field label="Expires" hint="Tokens always expire. Create a new one before then."><Select value={days} onChange={(e) => setDays(Number(e.target.value))}>{options.map((d) => <option key={d} value={d}>{d === maxDays ? "In a year" : `In ${d} days`}</option>)}</Select></Field>
        <div className="flex items-start gap-3"><Toggle checked={readOnly} onChange={setReadOnly} label="Read-only" /><div><div className="text-sm">Read-only</div><p className="text-xs text-ink-3">It can look at things but never change them.</p></div></div>
        <div className="flex items-start gap-3"><Toggle checked={privsep} onChange={setPrivsep} label="Separate privileges" /><div><div className="text-sm">Separate privileges</div><p className="text-xs text-ink-3">{PRIVSEP_HELP}</p></div></div>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function EpcTokens() {
  const me = useMe();
  const q = useQuery({ queryKey: EPC_KEY, queryFn: () => access.epcTokens.list(true), retry: 1 });
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<{ token: string; record: EpcToken; note: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => access.epcTokens.revoke(id),
    onSuccess: () => {
      setRevoking(null);
      qc.invalidateQueries({ queryKey: EPC_KEY });
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <QueryState query={q}>
      {q.data && (
        <section aria-label="ePaperclip API tokens">
          <SectionTitle action={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New API token</Button>}>ePaperclip API tokens</SectionTitle>
          <p className="text-compact text-ink-2 mb-3 max-w-2xl">Long-lived credentials for scripts and automation. Send one as <span className="font-mono">Authorization: Bearer …</span>. Only a hash is kept here, so a lost token can't be shown again; revoke it and make another.</p>
          {error && <p role="alert" className="text-compact text-critical mb-2">{error}</p>}
          {q.data.tokens.length === 0 ? (
            <EmptyState icon={<KeyRound className="h-5 w-5" />} title="No API tokens yet" body="Create one to call ePaperclip from a script, a cron job or another service." />
          ) : (
            <Table min="min-w-[720px]">
              <thead><tr className="border-b border-line"><Th>Name</Th>{q.data.scope === "all" && <Th>Owner</Th>}<Th>Access</Th><Th>Expires</Th><Th>Last used</Th><Th /></tr></thead>
              <tbody>
                {q.data.tokens.map((t) => (
                  <tr key={t.id} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                    <Td><div className="font-medium">{t.name}</div><div className="text-xs text-ink-3 font-mono">epc_{t.id}_…</div></Td>
                    {q.data.scope === "all" && <Td className="font-mono text-compact">{t.userid}</Td>}
                    <Td><div className="flex flex-wrap gap-1.5"><Chip tone={t.readOnly ? "neutral" : "accent"}>{t.readOnly ? "Read-only" : "Full"}</Chip>{t.privsep && <Chip tone="warning">Separate privileges</Chip>}</div></Td>
                    <Td className={t.expiresAt < Date.now() ? "text-critical" : "text-ink-2"}>{t.expiresAt < Date.now() ? "Expired " : ""}{dateOfMs(t.expiresAt)}</Td>
                    <Td className="text-ink-2">{t.lastUsedAt ? dateOfMs(t.lastUsedAt) : "Never"}</Td>
                    <Td className="text-right">
                      {t.userid === me || q.data.scope === "all" ? (revoking === t.id ? <Button size="sm" variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate(t.id)}>Revoke</Button> : <Button size="sm" variant="ghost" aria-label={`Revoke ${t.name}`} onClick={() => setRevoking(t.id)}><Trash2 className="h-4 w-4" /></Button>) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {creating && <CreateEpcToken maxDays={q.data.maxDays} defaultDays={q.data.defaultDays} onClose={() => setCreating(false)} onCreated={(r) => { setCreating(false); setShown(r); }} />}
          {shown && (
            <SecretOnce title={`API token “${shown.record.name}”`} secrets={[{ label: "Token", value: shown.token }, { label: "Try it", value: curlExample(shown.token) }]} onClose={() => setShown(null)}>
              <Notice tone={shown.record.privsep ? "warning" : "info"} title={shown.record.privsep ? "This token starts with no permissions" : "This token acts as you"}>
                {shown.note} Anyone holding it can do what it allows until it expires on {dateOfMs(shown.record.expiresAt)} or you revoke it. Mutations don't need a browser header; only send it over HTTPS.
              </Notice>
            </SecretOnce>
          )}
        </section>
      )}
    </QueryState>
  );
}

function TokenAcls({ token, onClose }: { token: PveToken; onClose: () => void }) {
  const qc = useQueryClient();
  const aclQ = useQuery({ queryKey: ["access", "acl"], queryFn: access.acl.list, retry: 0 });
  const rolesQ = useQuery({ queryKey: ["access", "roles"], queryFn: access.roles.list, retry: 0 });
  const [adding, setAdding] = useState(false);
  const mine = (aclQ.data?.acls ?? []).filter((a) => a.type === "token" && a.ugid === token.fullTokenid);
  const remove = useMutation({
    mutationFn: (a: (typeof mine)[number]) => access.acl.set({ path: a.path, roles: [a.roleid], tokens: [a.ugid], remove: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["access", "acl"] }),
  });
  return (
    <Modal size="md" title={`Permissions of ${token.tokenid}`} subtitle={token.privsep ? "This token has separate privileges: it can only do what is listed here." : "This token doesn't separate privileges: it acts as the user, and also gets anything listed here."} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button>{aclQ.data?.canModify && rolesQ.data && <Button variant="primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" />Add permission</Button>}</>}>
      {mine.length === 0 ? <p className="text-compact text-ink-3">No permissions of its own yet.</p> : (
        <ul className="rounded-lg border border-line divide-y divide-line">
          {mine.map((a) => (
            <li key={`${a.path}${a.roleid}`} className="flex items-center gap-3 px-3 py-2">
              <span className="font-mono text-compact flex-1">{a.path}</span><Chip tone="accent">{a.roleid}</Chip>
              {aclQ.data?.canModify && <Button size="sm" variant="ghost" aria-label={`Remove ${a.roleid} on ${a.path}`} onClick={() => remove.mutate(a)}><Trash2 className="h-4 w-4" /></Button>}
            </li>
          ))}
        </ul>
      )}
      {adding && rolesQ.data && <AddAclModal roles={rolesQ.data.roles} initial={{ type: "token", ugid: token.fullTokenid }} onClose={() => setAdding(false)} />}
    </Modal>
  );
}

function CreatePveToken({ userid, onClose, onCreated }: { userid: string; onClose: () => void; onCreated: (r: { fullTokenid: string; value: string; privsep: boolean }) => void }) {
  const qc = useQueryClient();
  const [tokenid, setTokenid] = useState("");
  const [comment, setComment] = useState("");
  const [expires, setExpires] = useState("");
  const [privsep, setPrivsep] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => access.users.createToken(userid, { tokenid: tokenid.trim(), comment: comment.trim() || undefined, expire: expires ? Math.floor(new Date(`${expires}T23:59:59`).getTime() / 1000) : 0, privsep }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["access", "pve-tokens", userid] });
      onCreated(r);
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal size="md" title={`New Proxmox API token for ${userid}`} subtitle="Works against Proxmox's own API, outside ePaperclip." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={!/^[A-Za-z][A-Za-z0-9._-]{1,63}$/.test(tokenid.trim())} onClick={() => create.mutate()}>Create token</Button></>}>
      <div className="space-y-4">
        <Field label="Token name" hint="Letters, digits, . _ and -. Names starting with epc- are kept for ePaperclip API tokens."><Input value={tokenid} onChange={(e) => setTokenid(e.target.value)} className="font-mono" autoFocus spellCheck={false} /></Field>
        <Field label="Comment"><Input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        <Field label="Expires" hint="Leave empty for no expiry."><Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
        <div className="flex items-start gap-3"><Toggle checked={privsep} onChange={setPrivsep} label="Separate privileges" /><div><div className="text-sm">Separate privileges</div><p className="text-xs text-ink-3">{PRIVSEP_HELP}</p></div></div>
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function PveTokens() {
  const me = useMe();
  const iacQ = useIac();
  const [userid, setUserid] = useState("");
  const who = userid || me;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["access", "pve-tokens", who], queryFn: () => access.users.tokens(who), enabled: !!who, retry: 0 });
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<{ title: string; value: string; privsep: boolean; full: string } | null>(null);
  const [aclsOf, setAclsOf] = useState<PveToken | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["access", "pve-tokens", who] });
  const remove = useMutation({ mutationFn: (id: string) => access.users.removeToken(who, id), onSuccess: () => { setDeleting(null); refresh(); }, onError: (e) => setError(errorText(e)) });
  const regen = useMutation({ mutationFn: (id: string) => access.users.updateToken(who, id, { regenerate: true }), onSuccess: (r, id) => { refresh(); if (r.value) setShown({ title: `New secret for ${id}`, value: r.value, privsep: true, full: `${who}!${id}` }); }, onError: (e) => setError(errorText(e)) });
  const privsepToggle = useMutation({ mutationFn: (t: PveToken) => access.users.updateToken(who, t.tokenid, { privsep: !t.privsep }), onSuccess: refresh, onError: (e) => setError(errorText(e)) });
  return (
    <section aria-label="Proxmox API tokens" className="mt-10">
      <SectionTitle action={<Button onClick={() => setCreating(true)} disabled={!who}><Plus className="h-4 w-4" />New Proxmox token</Button>}>Proxmox API tokens</SectionTitle>
      <p className="text-compact text-ink-2 mb-3 max-w-2xl">Tokens for Proxmox's own API. Each belongs to a user; with separate privileges it only has the permissions you give it here.</p>
      <div className="max-w-xs mb-3">
        <Field label="User"><Select value={who} onChange={(e) => setUserid(e.target.value)}>{(iacQ.data?.users ?? [{ userid: me }]).map((u) => <option key={u.userid} value={u.userid}>{u.userid}</option>)}</Select></Field>
      </div>
      {error && <p role="alert" className="text-compact text-critical mb-2">{error}</p>}
      <QueryState query={q}>
        {q.data && (q.data.tokens.length === 0 ? (
          <EmptyState icon={<KeyRound className="h-5 w-5" />} title="No Proxmox tokens for this user" body="Create one to let a tool call Proxmox's API without a password." />
        ) : (
          <Table min="min-w-[760px]">
            <thead><tr className="border-b border-line"><Th>Token</Th><Th>Privileges</Th><Th>Expires</Th><Th>Comment</Th><Th /></tr></thead>
            <tbody>
              {q.data.tokens.map((t) => (
                <tr key={t.tokenid} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                  <Td><div className="font-mono text-compact">{t.fullTokenid}</div>{t.epaperclip && <Chip tone="live">ePaperclip: {t.epaperclip.name}</Chip>}</Td>
                  <Td>{t.epaperclip ? <span className="text-compact text-ink-2">{t.privsep ? "Separate" : "Acts as the user"}</span> : <button className="text-compact text-accent hover:underline" onClick={() => privsepToggle.mutate(t)} title="Switch">{t.privsep ? "Separate" : "Acts as the user"}</button>}</Td>
                  <Td className="text-ink-2">{dateOf(t.expire)}</Td>
                  <Td className="text-ink-2">{t.comment ?? ""}</Td>
                  <Td className="text-right whitespace-nowrap">
                    {!t.epaperclip && <Button size="sm" variant="ghost" onClick={() => setAclsOf(t)}>Permissions</Button>}
                    {!t.epaperclip && <Button size="sm" variant="ghost" aria-label={`Generate a new secret for ${t.tokenid}`} onClick={() => regen.mutate(t.tokenid)}><RefreshCw className="h-4 w-4" /></Button>}
                    {deleting === t.tokenid ? <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate(t.tokenid)}>Delete</Button> : <Button size="sm" variant="ghost" aria-label={`Delete ${t.tokenid}`} onClick={() => setDeleting(t.tokenid)}><Trash2 className="h-4 w-4" /></Button>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ))}
      </QueryState>
      {creating && <CreatePveToken userid={who} onClose={() => setCreating(false)} onCreated={(r) => { setCreating(false); setShown({ title: `Proxmox token ${r.fullTokenid}`, value: r.value, privsep: r.privsep, full: r.fullTokenid }); }} />}
      {aclsOf && <TokenAcls token={aclsOf} onClose={() => setAclsOf(null)} />}
      {shown && (
        <SecretOnce title={shown.title} secrets={[{ label: "Token ID", value: shown.full }, { label: "Secret", value: shown.value }]} onClose={() => setShown(null)}>
          <Notice tone={shown.privsep ? "warning" : "info"} title={shown.privsep ? "Separate privileges" : "Acts as the user"}>
            {shown.privsep ? "This token can do nothing until you give it permissions (Permissions on its row)." : "This token has every permission its user has."} Send it to Proxmox as <span className="font-mono">Authorization: PVEAPIToken=ID=SECRET</span>.
          </Notice>
        </SecretOnce>
      )}
    </section>
  );
}

export function TokensTab() {
  return (
    <div>
      <EpcTokens />
      <PveTokens />
    </div>
  );
}
