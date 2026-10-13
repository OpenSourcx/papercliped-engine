import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePlus2, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2, Undo2 } from "lucide-react";
import { nodeApi, type AcmeInfo, type CertInfo } from "../../data/engine/nodeApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, Field, Input, Notice, PageFrame, PageHeader, SectionTitle, Select, Status, Tabs, Textarea, Toggle } from "../../ui/primitives.tsx";
import { Async, Denied, LiveOnly, NodeSwitcher, TasksLink, TypedConfirm, useNodeName, useTaskRunner } from "./common.tsx";
import { httpUrl } from "../../lib/safeUrl";

type Tab = "certificates" | "acme";
const day = (epoch: number | null) => (epoch ? new Date(epoch * 1000).toLocaleDateString([], { dateStyle: "medium" }) : "Unknown");

function expiry(c: CertInfo) {
  if (c.daysLeft === null) return <Status kind="idle" label="Expiry unknown" />;
  if (c.daysLeft < 0) return <Status kind="critical" label={`Expired ${-c.daysLeft} days ago`} />;
  if (c.daysLeft < 15) return <Status kind="warning" label={`Expires in ${c.daysLeft} days`} />;
  return <Status kind="good" label={`Valid for ${c.daysLeft} days`} />;
}

function UploadModal({ onClose, onDone }: { onClose: () => void; onDone: (r: Awaited<ReturnType<typeof nodeApi.uploadCertificate>>) => void }) {
  const { node } = useNodeName();
  const [cert, setCert] = useState("");
  const [key, setKey] = useState("");
  const shapeOk = /-----BEGIN CERTIFICATE-----/.test(cert) && /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(key);
  const up = useMutation({
    mutationFn: () => nodeApi.uploadCertificate(node, cert, key),
    onSuccess: (r) => {
      setKey("");
      setCert("");
      onDone(r);
      onClose();
    },
  });
  return (
    <Modal size="lg" icon={<FilePlus2 className="h-5 w-5" />} title="Upload a custom certificate" subtitle="Replaces the certificate this device presents on its web address." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!shapeOk} loading={up.isPending} onClick={() => up.mutate()}>Upload certificate</Button></>}>
      <div className="space-y-4">
        <Field label="Certificate chain (PEM)" hint="The certificate first, then any intermediate certificates. Up to 64 KB." htmlFor="cert-pem"><Textarea id="cert-pem" value={cert} onChange={(e) => setCert(e.target.value)} rows={7} className="font-mono text-xs" spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" /></Field>
        <Field label="Private key (PEM, without a passphrase)" hint="Sent to Proxmox once. It is never shown again, stored here or written to a log." htmlFor="cert-key"><Textarea id="cert-key" value={key} onChange={(e) => setKey(e.target.value)} rows={5} className="font-mono text-xs" spellCheck={false} autoComplete="off" placeholder="-----BEGIN PRIVATE KEY-----" /></Field>
        <Notice tone="warning" title="This changes how ePaperclip is served too">The web address of ePaperclip uses the same certificate. It picks the new one up on its own within moments. ePaperclip also talks to Proxmox on this device by its loopback address, so the certificate should list 127.0.0.1 or the device must be reached by name (see the note after uploading).</Notice>
        {up.error && <p role="alert" className="text-compact text-critical">{errorText(up.error)}</p>}
      </div>
    </Modal>
  );
}

function CertificatesTab() {
  const { node, name } = useNodeName();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["node", "certificates", name], queryFn: () => nodeApi.certificates(node), retry: 1 });
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof nodeApi.uploadCertificate>> | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["node", "certificates"] });
  const remove = useMutation({ mutationFn: () => nodeApi.deleteCertificate(node, "remove certificate"), onSuccess: () => { setRemoving(false); void refresh(); } });
  const reload = useMutation({ mutationFn: nodeApi.reloadCertificate, onSuccess: () => void refresh() });
  return (
    <Async q={q}>
      {(d) => {
        const active = d.certificates.find((c) => c.custom) ?? d.certificates[0];
        const stale = !!(d.serving?.fingerprint && active && active.fingerprint && d.serving.fingerprint.toUpperCase() !== active.fingerprint.toUpperCase());
        return (
          <div className="space-y-4">
            {result && (
              <Notice tone="good" title="Certificate uploaded">
                {result.tls?.reloaded ? "ePaperclip is already serving it." : result.tls?.reason ?? "ePaperclip will start serving it when it next reads the file."}
                {result.warnings.map((w) => <span key={w} className="block mt-1 text-warning">{w}</span>)}
              </Notice>
            )}
            {stale && <Notice tone="warning" title="ePaperclip is serving an older certificate" action={<Button size="sm" loading={reload.isPending} onClick={() => reload.mutate()}>Reload now</Button>}>Proxmox has a different certificate than the one on this page's address. Reloading re-reads the files without a restart.</Notice>}
            {reload.error && <p role="alert" className="text-compact text-critical">{errorText(reload.error)}</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => setUploading(true)}><FilePlus2 className="h-4 w-4" />Upload custom certificate…</Button>
              {d.certificates.some((c) => c.custom) && <Button variant="danger" onClick={() => setRemoving(true)}><Trash2 className="h-4 w-4" />Remove custom certificate…</Button>}
            </div>
            <div className="space-y-3">
              {d.certificates.map((c) => (
                <Card key={c.filename} className="p-5">
                  <div className="flex flex-wrap items-center gap-2 mb-3">
                    <ShieldCheck className="h-4 w-4 text-ink-2" aria-hidden />
                    <span className="font-medium">{c.subject || c.filename}</span>
                    <Chip tone={c.custom ? "accent" : "neutral"}>{c.custom ? "Custom" : c.filename === "pve-ssl.pem" ? "Node certificate" : c.filename}</Chip>
                    {c === active && <Chip tone="good">In use</Chip>}
                    <span className="ml-auto">{expiry(c)}</span>
                  </div>
                  <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3 text-compact">
                    <div><dt className="text-xs text-ink-3">Issued by</dt><dd className="break-words">{c.issuer || "Unknown"}</dd></div>
                    <div><dt className="text-xs text-ink-3">Valid</dt><dd>{day(c.notBefore)} to {day(c.notAfter)}</dd></div>
                    <div className="sm:col-span-2"><dt className="text-xs text-ink-3">Names</dt><dd className="flex flex-wrap gap-1.5 mt-1">{c.san.length ? c.san.map((s) => <Chip key={s}>{s}</Chip>) : <span className="text-ink-3">None listed</span>}</dd></div>
                    <div className="sm:col-span-2"><dt className="text-xs text-ink-3">Fingerprint (SHA-256)</dt><dd className="font-mono text-xs break-all">{c.fingerprint}</dd></div>
                    {c.keyType && <div><dt className="text-xs text-ink-3">Key</dt><dd>{c.keyType} {c.keyBits ? `${c.keyBits} bits` : ""}</dd></div>}
                  </dl>
                </Card>
              ))}
            </div>
            {uploading && <UploadModal onClose={() => setUploading(false)} onDone={(r) => { setResult(r); void refresh(); }} />}
            {removing && <TypedConfirm title="Remove the custom certificate?" phrase="remove certificate" action="Remove certificate" busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onClose={() => setRemoving(false)} onConfirm={() => remove.mutate()}><Notice tone="warning">The device goes back to its own self-signed certificate. Browsers will warn about it again.</Notice></TypedConfirm>}
          </div>
        );
      }}
    </Async>
  );
}

/* ── ACME ──────────────────────────────────────────────────────────────────────────── */

function AccountModal({ acme, onClose, onStart }: { acme: AcmeInfo; onClose: () => void; onStart: (title: string, run: () => Promise<{ task: string }>) => void }) {
  const [name, setName] = useState(acme.accounts.length ? "" : "default");
  const [contact, setContact] = useState("");
  const [dir, setDir] = useState(acme.directories[0]?.url ?? "");
  const [custom, setCustom] = useState("");
  const [accept, setAccept] = useState(false);
  const [kid, setKid] = useState("");
  const [hmac, setHmac] = useState("");
  const directory = dir === "custom" ? custom.trim() : dir;
  const tos = useQuery({ queryKey: ["node", "acme-tos", directory], queryFn: () => nodeApi.acmeTos(directory || undefined), enabled: /^https:\/\//.test(directory), retry: 0 });
  const ok = /^[A-Za-z][A-Za-z0-9_-]+$/.test(name) && /^[^\s@,]+@[^\s@,]+$/.test(contact.trim()) && /^https:\/\//.test(directory) && accept && (!tos.data?.externalAccountRequired || (kid && hmac));
  return (
    <Modal size="md" icon={<KeyRound className="h-5 w-5" />} title="Register an ACME account" subtitle="Needed once per certificate authority." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ok} onClick={() => { onStart("Register ACME account", () => nodeApi.createAcmeAccount({ name, contact: contact.trim(), directory, acceptTos: true, eabKid: kid || undefined, eabHmacKey: hmac || undefined })); onClose(); }}>Register account</Button></>}>
      <div className="space-y-4">
        <Field label="Account name" htmlFor="acme-name"><Input id="acme-name" value={name} onChange={(e) => setName(e.target.value)} className="font-mono" /></Field>
        <Field label="Contact email" hint="The certificate authority writes here about expiry and problems." htmlFor="acme-mail"><Input id="acme-mail" type="email" value={contact} onChange={(e) => setContact(e.target.value)} /></Field>
        <Field label="Certificate authority" htmlFor="acme-dir">
          <Select id="acme-dir" value={dir} onChange={(e) => setDir(e.target.value)}>{acme.directories.map((d) => <option key={d.url} value={d.url}>{d.name}</option>)}<option value="custom">Another directory address…</option></Select>
        </Field>
        {dir === "custom" && <Field label="Directory address" htmlFor="acme-custom"><Input id="acme-custom" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="https://" className="font-mono" /></Field>}
        {tos.data?.externalAccountRequired && (
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Key identifier" htmlFor="acme-kid"><Input id="acme-kid" value={kid} onChange={(e) => setKid(e.target.value)} className="font-mono" /></Field>
            <Field label="HMAC key" hint="Never shown again." htmlFor="acme-hmac"><Input id="acme-hmac" type="password" value={hmac} onChange={(e) => setHmac(e.target.value)} autoComplete="off" className="font-mono" /></Field>
          </div>
        )}
        <div className="flex items-start gap-3"><Toggle checked={accept} onChange={setAccept} label="Accept the terms of service" /><div className="text-compact text-ink-2">I accept the certificate authority's terms of service.{httpUrl(tos.data?.tos) && <> <a className="underline underline-offset-2" href={httpUrl(tos.data?.tos)!} target="_blank" rel="noreferrer noopener">Read them</a>.</>}</div></div>
      </div>
    </Modal>
  );
}

function PluginModal({ acme, existing, onClose, onDone }: { acme: AcmeInfo; existing: NonNullable<AcmeInfo["plugins"]>[number] | null; onClose: () => void; onDone: () => void }) {
  const [id, setId] = useState(existing?.id ?? "");
  const [type, setType] = useState<"dns" | "standalone">((existing?.type as "dns" | "standalone") ?? "dns");
  const [api, setApi] = useState(existing?.api ?? "");
  const [settings, setSettings] = useState("");
  const [delay, setDelay] = useState(existing?.validationDelay ?? 30);
  const schema = acme.challengeSchema.find((s) => s.id === api);
  const save = useMutation({ mutationFn: () => nodeApi.savePlugin({ id, type, api: type === "dns" ? api : undefined, settings: settings || undefined, "validation-delay": type === "dns" ? delay : undefined }, !existing), onSuccess: () => { setSettings(""); onDone(); onClose(); } });
  return (
    <Modal size="md" title={existing ? `Edit ${existing.id}` : "Add a challenge plugin"} subtitle="How Proxmox proves you control a domain." onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!/^[A-Za-z][A-Za-z0-9_-]+$/.test(id) || (type === "dns" && !api)} loading={save.isPending} onClick={() => save.mutate()}>Save plugin</Button></>}>
      <div className="space-y-4">
        <Field label="Plugin name" htmlFor="pl-id"><Input id="pl-id" value={id} disabled={!!existing} onChange={(e) => setId(e.target.value)} className="font-mono" /></Field>
        {!existing && <Field label="Type" htmlFor="pl-type"><Select id="pl-type" value={type} onChange={(e) => setType(e.target.value as "dns" | "standalone")}><option value="dns">DNS (works behind a firewall, supports wildcards)</option><option value="standalone">Standalone (port 80 must reach this device)</option></Select></Field>}
        {type === "dns" && (
          <>
            <Field label="DNS provider" htmlFor="pl-api"><Select id="pl-api" value={api} onChange={(e) => setApi(e.target.value)}><option value="">Choose a provider</option>{acme.apis.map((a) => <option key={a} value={a}>{acme.challengeSchema.find((s) => s.id === a)?.name ?? a}</option>)}</Select></Field>
            <Field label="Provider settings" hint={schema ? `Lines such as ${Object.keys(schema.fields).slice(0, 2).map((k) => `${k}=…`).join(" and ")}. ${existing?.hasSettings ? "Settings are saved and never shown; leave this blank to keep them." : ""}` : "One KEY=value per line. Never shown again."} htmlFor="pl-set"><Textarea id="pl-set" value={settings} onChange={(e) => setSettings(e.target.value)} rows={4} className="font-mono text-xs" spellCheck={false} autoComplete="off" /></Field>
            <Field label="Wait before validating (seconds)" hint="Gives slow DNS time to publish the record." htmlFor="pl-delay"><Input id="pl-delay" type="number" min={0} max={172800} value={delay} onChange={(e) => setDelay(Number(e.target.value))} className="tabular-nums" /></Field>
          </>
        )}
        {save.error && <p role="alert" className="text-compact text-critical">{errorText(save.error)}</p>}
      </div>
    </Modal>
  );
}

function AcmeTab() {
  const { node, name } = useNodeName();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["node", "acme", name], queryFn: () => nodeApi.acme(node), retry: 1 });
  const refresh = () => qc.invalidateQueries({ queryKey: ["node"] });
  const runner = useTaskRunner((exit) => {
    // The certificate changed on disk: have the host service re-read it, then refresh the lists.
    void nodeApi.reloadCertificate().catch(() => {}).finally(() => void refresh());
    void exit;
  });
  const [account, setAccount] = useState(false);
  const [plugin, setPlugin] = useState<NonNullable<AcmeInfo["plugins"]>[number] | "new" | null>(null);
  const [del, setDel] = useState<{ kind: "account" | "plugin" | "acme"; id: string } | null>(null);
  const [draft, setDraft] = useState<{ account: string | null; domains: { domain: string; plugin: string; alias: string }[] } | null>(null);
  const saveCfg = useMutation({ mutationFn: (v: NonNullable<typeof draft>) => nodeApi.saveAcmeConfig(node, { account: v.account, domains: v.domains.filter((d) => d.domain.trim()).map((d) => ({ domain: d.domain.trim(), plugin: d.plugin || undefined, alias: d.alias.trim() || undefined })), digest: q.data?.config?.digest }), onSuccess: () => { setDraft(null); void refresh(); } });
  const removing = useMutation({
    mutationFn: async (t: NonNullable<typeof del>) => {
      if (t.kind === "plugin") await nodeApi.deletePlugin(t.id);
      return t.kind === "plugin" ? null : t.kind === "account" ? await nodeApi.deleteAcmeAccount(t.id) : await nodeApi.revertAcmeCertificate(node, "remove certificate");
    },
    onSuccess: (r, t) => {
      setDel(null);
      void refresh();
      if (r) void runner.start(t.kind === "account" ? "Delete ACME account" : "Back to the node certificate", async () => r);
    },
  });
  return (
    <Async q={q}>
      {(a) => {
        const cfg = draft ?? { account: a.config?.account ?? null, domains: (a.config?.domains ?? []).map((d) => ({ domain: d.domain, plugin: d.plugin ?? "", alias: d.alias ?? "" })) };
        const configured = !!a.config?.account && (a.config?.domains.length ?? 0) > 0;
        return (
          <div className="space-y-8">
            <section>
              <SectionTitle action={<Button size="sm" onClick={() => setAccount(true)}><Plus className="h-4 w-4" />Register account…</Button>}>Accounts</SectionTitle>
              {a.accounts.length === 0 ? <Notice tone="info">No ACME account yet. Register one to order free certificates from a certificate authority such as Let's Encrypt.</Notice> : (
                <Card className="divide-y divide-line">{a.accounts.map((x) => <div key={x.name} className="flex items-center gap-3 px-4 py-3"><span className="font-mono flex-1">{x.name}</span><Button size="sm" variant="ghost" className="text-critical" onClick={() => setDel({ kind: "account", id: x.name })} aria-label={`Delete account ${x.name}`}><Trash2 className="h-4 w-4" /></Button></div>)}</Card>
              )}
            </section>
            <section>
              <SectionTitle action={a.pluginsDenied ? undefined : <Button size="sm" onClick={() => setPlugin("new")}><Plus className="h-4 w-4" />Add plugin…</Button>}>Challenge plugins</SectionTitle>
              {a.pluginsDenied || !a.plugins ? <Denied what="challenge plugins (they need the Sys.Modify permission)" /> : a.plugins.length === 0 ? <p className="text-compact text-ink-3">No plugins. The built-in standalone challenge needs port 80 on this device to be reachable from the internet; a DNS plugin does not.</p> : (
                <Card className="divide-y divide-line">{a.plugins.map((p) => <div key={p.id} className="flex items-center gap-3 px-4 py-3"><div className="min-w-0 flex-1"><span className="font-mono">{p.id}</span><span className="text-xs text-ink-3 ml-2">{p.type}{p.api ? ` · ${p.api}` : ""}{p.hasSettings ? " · settings saved" : ""}</span></div><Button size="sm" variant="ghost" onClick={() => setPlugin(p)}>Edit</Button><Button size="sm" variant="ghost" className="text-critical" onClick={() => setDel({ kind: "plugin", id: p.id })} aria-label={`Delete plugin ${p.id}`}><Trash2 className="h-4 w-4" /></Button></div>)}</Card>
              )}
            </section>
            <section>
              <SectionTitle>Domains for {a.node}</SectionTitle>
              {a.configDenied ? <Denied what="this device's ACME settings" /> : (
                <Card className="p-5 space-y-4">
                  <Field label="Account" htmlFor="cfg-acct"><Select id="cfg-acct" value={cfg.account ?? ""} onChange={(e) => setDraft({ ...cfg, account: e.target.value || null })}><option value="">None</option>{a.accounts.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</Select></Field>
                  <div className="space-y-3">
                    {cfg.domains.map((d, i) => (
                      <div key={i} className="grid sm:grid-cols-[1fr_11rem_1fr_auto] gap-2 items-end">
                        <Field label={i === 0 ? "Domain" : <span className="sr-only">Domain</span>}><Input aria-label="Domain" value={d.domain} onChange={(e) => setDraft({ ...cfg, domains: cfg.domains.map((x, j) => (j === i ? { ...x, domain: e.target.value } : x)) })} placeholder="pve.example.com" className="font-mono" /></Field>
                        <Field label={i === 0 ? "Challenge" : <span className="sr-only">Challenge</span>}><Select aria-label="Challenge" value={d.plugin} onChange={(e) => setDraft({ ...cfg, domains: cfg.domains.map((x, j) => (j === i ? { ...x, plugin: e.target.value } : x)) })}><option value="">Standalone</option>{(a.plugins ?? []).filter((p) => p.type === "dns").map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}</Select></Field>
                        <Field label={i === 0 ? "Validation domain (optional)" : <span className="sr-only">Alias</span>}><Input aria-label="Validation domain" value={d.alias} onChange={(e) => setDraft({ ...cfg, domains: cfg.domains.map((x, j) => (j === i ? { ...x, alias: e.target.value } : x)) })} className="font-mono" /></Field>
                        <Button variant="ghost" size="sm" aria-label="Remove domain" onClick={() => setDraft({ ...cfg, domains: cfg.domains.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    ))}
                    {cfg.domains.length < 6 && <Button size="sm" onClick={() => setDraft({ ...cfg, domains: [...cfg.domains, { domain: "", plugin: "", alias: "" }] })}><Plus className="h-4 w-4" />Add domain</Button>}
                  </div>
                  {saveCfg.error && <p role="alert" className="text-compact text-critical">{errorText(saveCfg.error)}</p>}
                  <div className="flex gap-2"><Button variant="primary" disabled={!draft} loading={saveCfg.isPending} onClick={() => draft && saveCfg.mutate(draft)}>Save domains</Button>{draft && <Button variant="ghost" onClick={() => setDraft(null)}>Discard</Button>}</div>
                </Card>
              )}
            </section>
            <section>
              <SectionTitle>Order a certificate</SectionTitle>
              <Card className="p-5">
                <p className="text-compact text-ink-3 mb-4">Orders run as a Proxmox task. Proxmox renews the certificate by itself before it expires; the new one is picked up here without a restart.</p>
                {runner.error && <p role="alert" className="text-compact text-critical mb-3">{runner.error}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" disabled={!configured || !!draft} loading={runner.busy} onClick={() => void runner.start("Order certificate", () => nodeApi.orderCertificate(node))}><ShieldCheck className="h-4 w-4" />Order certificate</Button>
                  <Button disabled={!configured || !!draft} onClick={() => void runner.start("Renew certificate", () => nodeApi.renewCertificate(node, true))}><RefreshCw className="h-4 w-4" />Renew now</Button>
                  <Button variant="ghost" onClick={() => setDel({ kind: "acme", id: "certificate" })}><Undo2 className="h-4 w-4" />Back to the node certificate…</Button>
                </div>
                {!configured && <p className="text-xs text-ink-3 mt-3">Choose an account and at least one domain first.</p>}
              </Card>
            </section>
            {account && <AccountModal acme={a} onClose={() => setAccount(false)} onStart={(t, run) => void runner.start(t, run)} />}
            {plugin && <PluginModal acme={a} existing={plugin === "new" ? null : plugin} onClose={() => setPlugin(null)} onDone={() => void refresh()} />}
            {del && (
              <TypedConfirm title={del.kind === "acme" ? "Go back to the node certificate?" : del.kind === "account" ? `Delete account ${del.id}?` : `Delete plugin ${del.id}?`} phrase={del.kind === "acme" ? "remove certificate" : del.id} action={del.kind === "acme" ? "Remove certificate" : "Delete"} busy={removing.isPending} error={removing.error ? errorText(removing.error) : null} onClose={() => setDel(null)} onConfirm={() => removing.mutate(del)}>
                <Notice tone="warning">{del.kind === "acme" ? "The ACME certificate is removed and the device uses its own self-signed certificate again." : del.kind === "account" ? "The account is deactivated at the certificate authority. Orders using it stop working." : "Domains that use this plugin can't be validated until you pick another."}</Notice>
              </TypedConfirm>
            )}
            {runner.modal}
          </div>
        );
      }}
    </Async>
  );
}

function CertificatesBody() {
  const [tab, setTab] = useState<Tab>("certificates");
  return (
    <>
      <Tabs<Tab> value={tab} onChange={setTab} className="mb-6" tabs={[{ id: "certificates", label: "Certificates" }, { id: "acme", label: "ACME (Let's Encrypt)" }]} />
      {tab === "certificates" ? <CertificatesTab /> : <AcmeTab />}
    </>
  );
}

export function CertificatesPage() {
  const { name, multi } = useNodeName();
  return (
    <PageFrame width="6xl">
      <PageHeader title="Certificates" subtitle={`The certificates ${name} presents. Upload your own, or let Proxmox order and renew one for you.`} actions={<>{multi && <NodeSwitcher />}<TasksLink type="acmenewcert" /></>} />
      <LiveOnly><CertificatesBody /></LiveOnly>
    </PageFrame>
  );
}
