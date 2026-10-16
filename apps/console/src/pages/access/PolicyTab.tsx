import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2, ShieldAlert } from "lucide-react";
import { accessAdmin, type IngressOrg } from "../../data/engine/accessAdmin.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Button, Chip, Input, Notice, SectionTitle, Textarea, Toggle } from "../../ui/primitives.tsx";
import { CopyButton, QueryState, ReadOnlyNote, AField as Field } from "./shared.tsx";

const KEY = ["access", "policy"] as const;

function SigninPolicy() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: accessAdmin.policy.get, retry: 0 });
  const [consent, setConsent] = useState("");
  const [wa, setWa] = useState({ rp: "", id: "", origin: "", allowSubdomains: true });
  const [u2f, setU2f] = useState({ appid: "", origin: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data) return;
    setConsent(q.data.consentText);
    setWa({ rp: q.data.webauthn?.rp ?? "", id: q.data.webauthn?.id ?? "", origin: q.data.webauthn?.origin ?? "", allowSubdomains: q.data.webauthn?.allowSubdomains ?? true });
    setU2f({ appid: q.data.u2f?.appid ?? "", origin: q.data.u2f?.origin ?? "" });
  }, [q.data]);
  const save = useMutation({
    mutationFn: (b: Parameters<typeof accessAdmin.policy.save>[0]) => accessAdmin.policy.save(b),
    onSuccess: () => {
      setError(null);
      setMsg("Saved in Proxmox.");
      qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => {
      setMsg(null);
      setError(errorText(e));
    },
  });
  const here = window.location;
  return (
    <QueryState query={q}>
      {q.data && (
        <div className="space-y-10">
          {!q.data.canManage && <ReadOnlyNote what="change the sign-in policy" />}
          <section aria-label="Login notice">
            <SectionTitle>Login notice</SectionTitle>
            <p className="text-compact text-ink-2 mb-3 max-w-2xl">Text people must acknowledge before they sign in, for example "Authorised use only". It is stored in Proxmox's datacenter options, so Proxmox's own sign-in shows it too.</p>
            <Field label="Notice" hint="Plain text, up to 65536 characters. Leave empty for none."><Textarea value={consent} onChange={(e) => setConsent(e.target.value)} disabled={!q.data.canManage} rows={5} /></Field>
            <Button className="mt-3" variant="primary" disabled={!q.data.canManage || consent === q.data.consentText} loading={save.isPending} onClick={() => save.mutate({ consentText: consent.trim() === "" ? null : consent })}>Save notice</Button>
          </section>
          <section aria-label="Security keys">
            <SectionTitle>Security keys (WebAuthn)</SectionTitle>
            <p className="text-compact text-ink-2 mb-3 max-w-2xl">A security key is tied to the address it was registered on. Proxmox keeps one address for all keys, so to register keys here this must be this page's address: <span className="font-mono">{here.origin}</span>. Changing it later may break keys that already exist.</p>
            <div className="grid sm:grid-cols-3 gap-3 max-w-3xl">
              <Field label="Name shown to the key" hint="Any text, for example Acme."><Input value={wa.rp} onChange={(e) => setWa({ ...wa, rp: e.target.value })} disabled={!q.data.canManage} /></Field>
              <Field label="Relying-party id" hint="A domain name, no port."><Input value={wa.id} onChange={(e) => setWa({ ...wa, id: e.target.value.trim() })} disabled={!q.data.canManage} className="font-mono" placeholder={here.hostname} spellCheck={false} /></Field>
              <Field label="Origin" hint="https:// address people type."><Input value={wa.origin} onChange={(e) => setWa({ ...wa, origin: e.target.value.trim() })} disabled={!q.data.canManage} className="font-mono" placeholder={here.origin} spellCheck={false} /></Field>
            </div>
            <div className="flex items-center gap-3 mt-3"><Toggle checked={wa.allowSubdomains} onChange={(v) => setWa({ ...wa, allowSubdomains: v })} label="Allow subdomains" disabled={!q.data.canManage} /><span className="text-compact text-ink-2">Allow subdomains of the origin</span></div>
            <div className="flex gap-2 mt-3">
              <Button variant="primary" loading={save.isPending} disabled={!q.data.canManage || !wa.rp || !wa.id || !wa.origin} onClick={() => save.mutate({ webauthn: wa })}>Save security key settings</Button>
              <Button disabled={!q.data.canManage} onClick={() => setWa({ rp: "ePaperclip", id: here.hostname, origin: here.origin, allowSubdomains: false })}>Use this page's address</Button>
              {q.data.webauthn && <Button variant="ghost" disabled={!q.data.canManage} onClick={() => save.mutate({ webauthn: null })}>Clear</Button>}
            </div>
          </section>
          <section aria-label="Legacy U2F">
            <SectionTitle>U2F (older security keys)</SectionTitle>
            <div className="grid sm:grid-cols-2 gap-3 max-w-2xl">
              <Field label="App id" hint="Defaults to the origin."><Input value={u2f.appid} onChange={(e) => setU2f({ ...u2f, appid: e.target.value.trim() })} disabled={!q.data.canManage} className="font-mono" spellCheck={false} /></Field>
              <Field label="Origin override"><Input value={u2f.origin} onChange={(e) => setU2f({ ...u2f, origin: e.target.value.trim() })} disabled={!q.data.canManage} className="font-mono" spellCheck={false} /></Field>
            </div>
            <div className="flex gap-2 mt-3">
              <Button disabled={!q.data.canManage || (!u2f.appid && !u2f.origin)} onClick={() => save.mutate({ u2f: { appid: u2f.appid || undefined, origin: u2f.origin || undefined } })}>Save U2F settings</Button>
              {q.data.u2f && <Button variant="ghost" disabled={!q.data.canManage} onClick={() => save.mutate({ u2f: null })}>Clear</Button>}
            </div>
          </section>
          {error && <p role="alert" className="text-compact text-critical">{error}</p>}
          {msg && <p role="status" className="text-compact text-good">{msg}</p>}
        </div>
      )}
    </QueryState>
  );
}

function OrgIngress({ org, path, onChange }: { org: IngressOrg; path: string; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const toggle = useMutation({ mutationFn: (v: boolean) => accessAdmin.ingress.set(org.companyId, v), onSuccess: onChange, onError: (e) => setError(errorText(e)) });
  const urlOf = (id: string) => `${window.location.origin}${path.replace("{id}", id)}`;
  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1"><div className="font-medium truncate">{org.name}</div><div className="text-xs text-ink-3">{org.enabled ? `Open since ${new Date(org.enabledAt!).toLocaleDateString()}${org.by ? ` by ${org.by}` : ""}` : "Closed"}</div></div>
        <Toggle checked={org.enabled} onChange={(v) => toggle.mutate(v)} label={`Accept webhooks from outside for ${org.name}`} disabled={toggle.isPending} />
      </div>
      {error && <p role="alert" className="text-compact text-critical mt-2">{error}</p>}
      {org.enabled && org.error && <p className="text-compact text-warning mt-2">The routines couldn't be read: {org.error}</p>}
      {org.enabled && !org.error && org.hooks.length === 0 && <p className="text-compact text-ink-3 mt-2">No routine has a webhook trigger yet. Add one to a routine and its public address appears here.</p>}
      {org.enabled && org.hooks.length > 0 && (
        <ul className="mt-3 space-y-2">
          {org.hooks.map((h) => (
            <li key={h.triggerId} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center gap-2 mb-1.5"><span className="text-compact font-medium">{h.routine}</span>{h.label && <span className="text-xs text-ink-3">{h.label}</span>}<Chip tone={h.signingMode === "none" ? "warning" : "good"}>{h.signingMode === "none" ? "No signature check" : `Signed (${h.signingMode})`}</Chip>{!h.enabled && <Chip>Paused</Chip>}</div>
              <div className="flex items-center gap-2"><code className="flex-1 min-w-0 text-compact font-mono break-all select-all">{urlOf(h.publicId)}</code><CopyButton text={urlOf(h.publicId)} /></div>
              {h.signingMode === "none" && <p className="text-xs text-warning mt-1.5">Anyone who learns this address can start the routine. Choose a signed mode on the routine's trigger.</p>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Ingress() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["access", "ingress"], queryFn: accessAdmin.ingress.get, retry: 0 });
  return (
    <section aria-label="Routine webhooks from outside">
      <SectionTitle>Routine webhooks from outside</SectionTitle>
      <p className="text-compact text-ink-2 mb-3 max-w-2xl">A routine's webhook trigger normally works only inside this device. Opening an organization lets services such as GitHub call its webhook triggers over the internet. Off by default.</p>
      <Notice tone="warning" title="This is the one door that needs no sign-in" className="mb-4">
        <ShieldAlert className="inline h-4 w-4 mr-1" aria-hidden />It accepts POST requests to <span className="font-mono">/hooks/routines/&lt;id&gt;/fire</span> from anywhere, up to 64 KiB of JSON, rate limited, and nothing else. The routine's own signature check is what proves a call is genuine; a trigger set to "no signature check" is protected only by its secret address. See the security notes for the full risk.
      </Notice>
      <QueryState query={q}>
        {q.data && (q.data.organizations.length === 0 ? <p className="text-compact text-ink-3">There are no organizations yet.</p> : (
          <ul className="rounded-xl border border-line divide-y divide-line bg-surface">{q.data.organizations.map((o) => <OrgIngress key={o.companyId} org={o} path={q.data.path} onChange={() => qc.invalidateQueries({ queryKey: ["access", "ingress"] })} />)}</ul>
        ))}
      </QueryState>
    </section>
  );
}

/** Sign-in policy and the one public door. Administrators only. */
export function PolicyTab() {
  return (
    <div className="space-y-12">
      <SigninPolicy />
      <div className="flex items-center gap-2 text-ink-3 text-xs"><Globe2 className="h-4 w-4" aria-hidden />Outside access</div>
      <Ingress />
    </div>
  );
}
