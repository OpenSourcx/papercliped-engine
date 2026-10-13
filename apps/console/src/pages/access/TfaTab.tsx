import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { access, type TfaEntry } from "../../data/engine/access.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Chip, EmptyState, Input, Notice, SectionTitle, Select, Toggle } from "../../ui/primitives.tsx";
import { QrCode } from "./qr.tsx";
import { CopyButton, QueryState, SecretOnce, Table, Td, Th, dateOf, useIac, useMe, AField as Field } from "./shared.tsx";
import { groupKey, newSecret, otpauthUri } from "./totp.ts";

const TYPE_LABEL: Record<string, string> = { totp: "Authenticator app", recovery: "Recovery keys", webauthn: "Security key", u2f: "Security key (U2F)", yubico: "Yubico OTP" };
const key = (userid: string) => ["access", "tfa", userid] as const;

function AddTotp({ userid, mine, onClose }: { userid: string; mine: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const secret = useMemo(() => newSecret(), []);
  const uri = useMemo(() => otpauthUri({ secret, userid, issuer: `Proxmox ${window.location.hostname}` }), [secret, userid]);
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => access.tfa.addTotp(userid, { totp: uri, value: code.trim(), description: description.trim() || undefined, password: password || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key(userid) });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal size="md" icon={<Smartphone className="h-5 w-5" />} title="Add an authenticator app" subtitle={`Second factor for ${userid}. The code is made here in your browser and sent only to Proxmox.`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={add.isPending} disabled={!/^\d{6}$/.test(code.trim()) || (mine && !password)} onClick={() => add.mutate()}>Add authenticator</Button></>}>
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row gap-4 items-center">
          <QrCode text={uri} label={`Scan to add ${userid} to an authenticator app`} />
          <div className="min-w-0 space-y-2">
            <p className="text-compact text-ink-2">Scan the code with your authenticator app, or type this key in by hand.</p>
            <div className="font-mono text-compact break-all rounded-lg bg-code border border-line p-2 select-all" data-testid="setup-key">{groupKey(secret)}</div>
            <CopyButton text={secret} label="Copy key" />
          </div>
        </div>
        <Field label="Description" hint="So you can tell entries apart, for example Phone."><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={255} /></Field>
        <Field label="Current code" hint="The six digits your app shows now. Proxmox checks it before saving."><Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" className="font-mono tracking-code" /></Field>
        {mine && <Field label="Your password" hint="Proxmox asks for it when you change your own two-factor settings."><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function AddRecovery({ userid, mine, onClose }: { userid: string; mine: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [keys, setKeys] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => access.tfa.addRecovery(userid, { password: password || undefined }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: key(userid) });
      setKeys(r.recovery);
    },
    onError: (e) => setError(errorText(e)),
  });
  if (keys) return <SecretOnce title="Recovery keys" subtitle="Each key works once, in place of a code. Keep them somewhere safe; this is the only time they are shown." secrets={[{ label: "Keys", value: keys.join("\n") }]} onClose={onClose} />;
  return (
    <Modal size="sm" title="Create recovery keys" subtitle="A set of one-time keys for when you can't use your authenticator. Creating a new set replaces the old one." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={add.isPending} disabled={mine && !password} onClick={() => add.mutate()}>Create keys</Button></>}>
      <div className="space-y-4">
        {mine && <Field label="Your password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus /></Field>}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

function ConfirmRemove({ userid, entry, mine, onClose }: { userid: string; entry: TfaEntry; mine: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => access.tfa.remove(userid, entry.id, password || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key(userid) });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal size="sm" title={`Remove ${TYPE_LABEL[entry.type] ?? entry.type}?`} subtitle={mine ? "Proxmox asks for your password to confirm." : `This removes it from ${userid}. They can add it again.`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={remove.isPending} disabled={mine && !password} onClick={() => remove.mutate()}>Remove</Button></>}>
      <div className="space-y-4">
        {mine && <Field label="Your password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus /></Field>}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

export function TfaTab() {
  const me = useMe();
  const iacQ = useIac();
  const [pick, setPick] = useState("");
  const userid = pick || me;
  const mine = userid === me;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: key(userid), queryFn: () => access.tfa.forUser(userid), enabled: !!userid, retry: 0 });
  const locks = useQuery({ queryKey: ["access", "tfa", "all"], queryFn: access.tfa.all, retry: 0 });
  const lock = locks.data?.users.find((u) => u.userid === userid);
  const [adding, setAdding] = useState<"totp" | "recovery" | null>(null);
  const [removing, setRemoving] = useState<TfaEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pwFor, setPwFor] = useState<{ entry: TfaEntry; enable: boolean } | null>(null);
  const [pw, setPw] = useState("");
  const toggle = useMutation({
    mutationFn: (v: { entry: TfaEntry; enable: boolean; password?: string }) => access.tfa.update(userid, v.entry.id, { enable: v.enable, password: v.password }),
    onSuccess: () => {
      setPwFor(null);
      setPw("");
      qc.invalidateQueries({ queryKey: key(userid) });
    },
    onError: (e) => setError(errorText(e)),
  });
  const unlock = useMutation({ mutationFn: () => access.users.unlockTfa(userid), onSuccess: () => qc.invalidateQueries({ queryKey: ["access", "tfa", "all"] }), onError: (e) => setError(errorText(e)) });
  const users = iacQ.data?.users ?? (me ? [{ userid: me }] : []);
  return (
    <div>
      <SectionTitle action={<><Button onClick={() => setAdding("recovery")}><Plus className="h-4 w-4" />Recovery keys</Button><Button variant="primary" onClick={() => setAdding("totp")}><Plus className="h-4 w-4" />Authenticator app</Button></>}>Two-factor sign-in</SectionTitle>
      <p className="text-compact text-ink-2 mb-3 max-w-2xl">A second step when signing in: a code from an app on your phone, or a recovery key. It is enforced by Proxmox, so it applies to the Proxmox console and every API sign-in as well.</p>
      <div className="max-w-xs mb-4"><Field label="User"><Select value={userid} onChange={(e) => setPick(e.target.value)}>{users.map((u) => <option key={u.userid} value={u.userid}>{u.userid}{u.userid === me ? " (you)" : ""}</option>)}</Select></Field></div>
      {lock && (lock.totpLocked || lock.lockedUntil) && (
        <Notice tone="warning" title="Locked out of second factors" action={<Button size="sm" loading={unlock.isPending} onClick={() => unlock.mutate()}>Unlock</Button>}>Too many wrong codes. Proxmox locks the account for a while; unlocking lets {userid} try again now.</Notice>
      )}
      {error && <p role="alert" className="text-compact text-critical my-2">{error}</p>}
      <QueryState query={q}>
        {q.data && (q.data.entries.length === 0 ? (
          <EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="No second factor set up" body={mine ? "Add an authenticator app, then create recovery keys in case you lose your phone." : `${userid} signs in with a password only.`} />
        ) : (
          <Table>
            <thead><tr className="border-b border-line"><Th>Kind</Th><Th>Description</Th><Th>Added</Th><Th>Enabled</Th><Th /></tr></thead>
            <tbody>
              {q.data.entries.map((e) => (
                <tr key={e.id} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                  <Td><Chip tone={e.type === "recovery" ? "neutral" : "accent"}>{TYPE_LABEL[e.type] ?? e.type}</Chip></Td>
                  <Td>{e.description || <span className="text-ink-3">None</span>}</Td>
                  <Td className="text-ink-2">{dateOf(e.created)}</Td>
                  <Td><Toggle checked={e.enabled} label={`${TYPE_LABEL[e.type] ?? e.type} enabled`} onChange={(v) => (mine ? setPwFor({ entry: e, enable: v }) : toggle.mutate({ entry: e, enable: v }))} /></Td>
                  <Td className="text-right"><Button size="sm" variant="ghost" aria-label={`Remove ${TYPE_LABEL[e.type] ?? e.type}`} onClick={() => setRemoving(e)}><Trash2 className="h-4 w-4" /></Button></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ))}
      </QueryState>
      <p className="text-xs text-ink-3 mt-3">Security keys (WebAuthn) are listed here and can be removed, but they are added in Proxmox: a key is tied to the web address it was registered on, and Proxmox's own address is the one it is configured for. If a key is someone's only second factor, ePaperclip sign-in tells them so and points them to Proxmox.</p>
      {adding === "totp" && <AddTotp userid={userid} mine={mine} onClose={() => setAdding(null)} />}
      {adding === "recovery" && <AddRecovery userid={userid} mine={mine} onClose={() => setAdding(null)} />}
      {removing && <ConfirmRemove userid={userid} entry={removing} mine={mine} onClose={() => setRemoving(null)} />}
      {pwFor && (
        <Modal size="sm" title="Confirm with your password" subtitle="Proxmox asks for it when you change your own two-factor settings." onClose={() => setPwFor(null)}
          footer={<><Button variant="ghost" onClick={() => setPwFor(null)}>Cancel</Button><Button variant="primary" loading={toggle.isPending} disabled={!pw} onClick={() => toggle.mutate({ entry: pwFor.entry, enable: pwFor.enable, password: pw })}>{pwFor.enable ? "Enable" : "Disable"}</Button></>}>
          <Field label="Your password"><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" autoFocus /></Field>
        </Modal>
      )}
    </div>
  );
}
