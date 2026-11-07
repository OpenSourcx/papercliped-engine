import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import type { ChatEndpoint, ConnectToolAppResult, FieldDef, ToolCatalogEntry } from "@papercliped-engine/engine-client";
import { engine, useAgents } from "../../../data/engine/queries.ts";
import { nativeAppApi } from "../../../data/engine/connectApi.ts";
import { httpUrl } from "../../../lib/safeUrl.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { ProviderMark } from "../../../ui/ProviderMark.tsx";
import { Button, Field, Input, Notice, Select, Textarea, Toggle } from "../../../ui/primitives.tsx";
import { ActionError, LoadError, Loading } from "./common.tsx";
import { appKey, type PickedApp } from "./LiveOrganizationApps.tsx";
import { readAppAccess } from "./appAccess.ts";
import { configPayload, credentialPayload, defaultValues, fieldError, firstFieldError, shownFields, type FieldValues } from "./setupFields.ts";

function ProviderLink({ url, children }: { url?: string | null; children: ReactNode }) {
  const href = url && httpUrl(url);
  return href ? <a href={httpUrl(url) ?? undefined} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-compact text-accent hover:underline">{children}<ExternalLink className="h-3.5 w-3.5" /></a> : null;
}

function SetupFields({ fields, values, setValues, errors }: { fields: FieldDef[]; values: FieldValues; setValues: (value: FieldValues) => void; errors?: boolean }) {
  const [advanced, setAdvanced] = useState(false);
  const shown = shownFields(fields);
  const set = (key: string, value: string | boolean) => setValues({ ...values, [key]: value });
  const render = (field: FieldDef) => {
    const id = `app-${field.key}`;
    const value = values[field.key];
    if (field.type === "checkbox") return <div key={field.key}><Toggle label={field.label} checked={value === true} onChange={(checked) => set(field.key, checked)} />{field.helperMd && <p className="mt-1 text-xs text-ink-3">{field.helperMd}</p>}</div>;
    const error = errors ? fieldError(field, value) : null;
    return <Field key={field.key} label={`${field.label}${field.required ? " *" : ""}`} htmlFor={id} hint={field.helperMd} error={error}>
      {field.type === "select" ? <Select id={id} value={typeof value === "string" ? value : ""} onChange={(e) => set(field.key, e.target.value)}><option value="">Choose…</option>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select>
        : field.type === "textarea" ? <Textarea id={id} rows={4} autoComplete="off" value={typeof value === "string" ? value : ""} placeholder={field.placeholder} maxLength={field.validation?.maxLength} onChange={(e) => set(field.key, e.target.value)} />
        : <Input id={id} type={field.secret || field.type === "password" ? "password" : "text"} autoComplete="off" spellCheck={false} value={typeof value === "string" ? value : ""} placeholder={field.type === "datetime" ? field.placeholder ?? "2026-11-07T15:30" : field.placeholder} maxLength={field.validation?.maxLength} onChange={(e) => set(field.key, e.target.value)} />}
    </Field>;
  };
  const basic = shown.filter((field) => !field.advanced);
  const extra = shown.filter((field) => field.advanced);
  return <>{basic.map(render)}{extra.length > 0 && <><Button size="sm" variant="ghost" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>{advanced ? "Hide advanced settings" : "Show advanced settings"}</Button>{advanced && extra.map(render)}</>}</>;
}

export function AppSetup({ companyId, picked: { app, method }, onClose, onReview }: { companyId: string; picked: PickedApp; onClose: () => void; onReview: (id: string) => void }) {
  const address = useQuery({ queryKey: ["native-apps", "status"], queryFn: nativeAppApi.status, enabled: method.auth === "oauth" });
  const callback = address.data?.callbackUrl;
  const oauthReady = method.auth !== "oauth" || !!callback && new URL(callback).origin === window.location.origin;
  const tenantFields = method.tenantFields ?? [];
  const credentialFields = method.credentialFields ?? [];
  const [credentials, setCredentials] = useState<FieldValues>(() => defaultValues(credentialFields));
  const [config, setConfig] = useState<FieldValues>(() => defaultValues(tenantFields));
  const [checked, setChecked] = useState(false);
  const [result, setResult] = useState<ConnectToolAppResult | null>(null);
  const [client, setClient] = useState({ clientId: "", clientSecret: "" });
  const problem = firstFieldError(tenantFields, config) ?? firstFieldError(credentialFields, credentials);
  const connect = useMutation({
    mutationFn: () => engine.apps.connect(companyId, {
      galleryKey: app.slug, connectionMethodKey: method.key, grantKind: "organization", credentialValues: credentialPayload(credentialFields, credentials), configValues: configPayload(tenantFields, config),
      // A provider that supports neither client metadata nor dynamic registration needs the operator's own registered client; the draft is resumed, not duplicated.
      ...(result?.auth?.manualClientRequired ? { resumeConnectionId: result.connectionId, oauthClient: { clientId: client.clientId.trim(), ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}) } } : {}),
    }),
    onSuccess: (value) => { setCredentials(defaultValues(credentialFields)); setClient({ clientId: "", clientSecret: "" }); setResult(value); if (!value.auth) onReview(value.connectionId); },
  });
  const manual = result?.auth?.manualClientRequired === true;
  const submit = () => { if (manual ? !client.clientId.trim() : problem) { setChecked(true); return; } connect.mutate(); };
  const finished = result && !manual;
  return <Modal title={`Connect ${app.name}`} icon={<ProviderMark id={app.slug} name={app.name} />} onClose={onClose} footer={<><Button onClick={onClose}>Close</Button>{finished ? <Button variant="primary" onClick={() => onReview(result.connectionId)}>Review agent access</Button> : <Button variant="primary" disabled={!oauthReady} loading={connect.isPending} onClick={submit}>{manual ? "Save client and continue" : method.auth === "oauth" ? `Sign in with ${app.name}` : "Connect"}</Button>}</>}>
    <div className="space-y-4"><p className="text-sm text-ink-2">{method.whenToUse}</p><p className="text-compact text-ink-3">{method.guidanceMd}</p>
      <ProviderLink url={method.consoleLinks?.register ?? method.consoleLinks?.keys ?? method.consoleLinks?.docs}>Open {app.name} setup</ProviderLink>
      {method.auth === "oauth" && !oauthReady && address.data && <Notice tone="warning">This device’s provider sign-in address does not match the console address. A device administrator must configure its public address before browser sign-in can work.</Notice>}
      <ActionError error={address.error} />
      {!result && <><SetupFields fields={tenantFields} values={config} setValues={setConfig} errors={checked} /><SetupFields fields={credentialFields} values={credentials} setValues={setCredentials} errors={checked} /></>}
      {manual && <><Notice tone="warning" title="Register an OAuth client first">{app.name} cannot register this device automatically. Create an OAuth app in {app.name} with the redirect address <span className="font-mono break-all">{callback ?? "shown on the Access page"}</span>, then paste its client ID (and secret, if it has one). The secret is stored in this device’s vault and is never shown again.</Notice>
        <Field label="Client ID *" htmlFor="oauth-client-id" error={checked && !client.clientId.trim() ? "Client ID is required." : null}><Input id="oauth-client-id" autoComplete="off" spellCheck={false} value={client.clientId} onChange={(e) => setClient({ ...client, clientId: e.target.value })} /></Field>
        <Field label="Client secret" htmlFor="oauth-client-secret" hint="Leave empty for a public client."><Input id="oauth-client-secret" type="password" autoComplete="off" value={client.clientSecret} onChange={(e) => setClient({ ...client, clientSecret: e.target.value })} /></Field></>}
      {result?.auth && !manual && <Notice tone="info">Finish sign-in on the provider’s page, then return to review access. <ProviderLink url={result.auth.startUrl}>Continue to {app.name}</ProviderLink></Notice>}
      <ActionError error={connect.error} />
    </div>
  </Modal>;
}

export function ToolReview({ companyId, connectionId, onClose }: { companyId: string; connectionId: string; onClose: () => void }) {
  const agents = useAgents(companyId);
  const catalog = useQuery({ queryKey: [...appKey(companyId), connectionId, "catalog"], queryFn: () => engine.apps.catalog(connectionId) });
  // Current grants come from the engine; no existing-grant read means no save, so a failed read can never look like "no access".
  const current = useQuery({ queryKey: [...appKey(companyId), connectionId, "access"], refetchOnWindowFocus: false, queryFn: async () => readAppAccess(connectionId, (await engine.apps.profiles(companyId)).profiles, (await engine.apps.policies(companyId)).policies) });
  const [allAgentsEdit, setAllAgents] = useState<boolean | null>(null);
  const [agentEdits, setAgentEdits] = useState<Record<string, boolean>>({});
  const [policyEdits, setPolicies] = useState<Record<string, "off" | "ask" | "allow">>({});
  const base = current.data;
  const allAgents = allAgentsEdit ?? base?.allAgents ?? false;
  const agentOn = (id: string) => agentEdits[id] ?? base?.agentIds.includes(id) ?? false;
  const policy = (entry: ToolCatalogEntry): "off" | "ask" | "allow" => entry.status === "disabled" ? "off" : policyEdits[entry.id] ?? (base?.askFirst.includes(entry.id) ? "ask" : base?.enabled.includes(entry.id) ? "allow" : "off");
  const entries = catalog.data?.catalog ?? [];
  // Bindings to agents the list no longer shows (for example terminated ones) are kept, not silently dropped.
  const agentIds = [...new Set([...(base?.agentIds ?? []), ...(agents.data ?? []).map((agent) => agent.id)])].filter(agentOn);
  const save = useMutation({ mutationFn: () => engine.apps.finish(companyId, connectionId, { preserveExistingAccess: false, access: allAgents ? "all_agents" : { agentIds }, enabledCatalogEntryIds: entries.filter((entry) => policy(entry) !== "off").map((entry) => entry.id), askFirstCatalogEntryIds: entries.filter((entry) => policy(entry) === "ask").map((entry) => entry.id), reviewedCatalogEntryIds: entries.filter((entry) => entry.status === "quarantined").map((entry) => entry.id) }), onSuccess: () => { void current.refetch(); onClose(); } });
  const refresh = useMutation({ mutationFn: () => engine.apps.refresh(connectionId), onSuccess: () => void catalog.refetch() });
  return <Modal title="Set agent access" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!catalog.data || !agents.data || !base || !!base.advanced || refresh.isPending} onClick={() => save.mutate()}>Save access</Button></>}>
    <div className="space-y-4">
      {current.error && <LoadError error={current.error} retry={() => void current.refetch()} />}
      {base?.advanced && <Notice tone="warning">This connection has {base.advanced}, which this editor cannot show. Saving here would remove it, so editing is disabled. Change it in the engine’s tool access settings.</Notice>}
      {agents.error && <LoadError error={agents.error} retry={() => void agents.refetch()} />}
      <Toggle label="All agents, including agents added later" checked={allAgents} onChange={setAllAgents} />
      {!allAgents && agents.data?.filter((agent) => agent.status !== "terminated").map((agent) => <Toggle key={agent.id} label={agent.name} checked={agentOn(agent.id)} onChange={(checked) => setAgentEdits({ ...agentEdits, [agent.id]: checked })} />)}
      <Button size="sm" loading={refresh.isPending} onClick={() => refresh.mutate()}>Refresh available actions</Button>
      {catalog.isPending && <Loading />}{catalog.error && <LoadError error={catalog.error} retry={() => void catalog.refetch()} />}
      {catalog.data?.catalog.length === 0 && <p className="text-sm text-ink-3">No actions discovered. Finish provider sign-in, then refresh.</p>}
      {catalog.data?.catalog.map((entry) => <Field key={entry.id} label={entry.title ?? entry.toolName} htmlFor={`policy-${entry.id}`} hint={entry.status === "disabled" ? "Unavailable at the provider" : entry.isDestructive ? "Destructive action" : entry.isReadOnly ? "Read only" : "Can change provider data"}><p className="mb-2 text-xs text-ink-3">{entry.description}</p><Select id={`policy-${entry.id}`} value={policy(entry)} disabled={entry.status === "disabled" || !base} onChange={(e) => setPolicies({ ...policyEdits, [entry.id]: e.target.value as "off" | "ask" | "allow" })}><option value="off">Off</option><option value="ask">Ask for approval</option><option value="allow">Allow</option></Select></Field>)}
      <ActionError error={save.error ?? refresh.error} />
    </div>
  </Modal>;
}

export function ChannelSetup({ companyId, picked, existing, onClose }: { companyId: string; picked?: PickedApp; existing?: ChatEndpoint; onClose: () => void }) {
  const agents = useAgents(companyId);
  const [agentId, setAgentId] = useState("");
  const [endpoint, setEndpoint] = useState(existing ?? null);
  const [credentials, setCredentials] = useState<FieldValues>(() => defaultValues(picked?.method.credentialFields ?? []));
  const provider = picked?.method.provider ?? existing?.provider;
  const fields = picked?.method.credentialFields ?? [];
  const create = useMutation({ mutationFn: () => engine.channels.create(companyId, { provider: provider as "slack" | "discord", assignedAgentId: agentId }), onSuccess: setEndpoint });
  const configure = useMutation({ mutationFn: (action: "configure" | "verify" | "pause" | "resume" | "remove") => engine.channels.configure(endpoint!.id, { action, ...(action === "configure" ? { credentials: credentialPayload(fields, credentials) } : {}) }), onSuccess: (value, action) => { setCredentials(defaultValues(fields)); if (action === "remove") onClose(); else setEndpoint(value); } });
  const check = useMutation({ mutationFn: () => engine.channels.get(endpoint!.id), onSuccess: setEndpoint });
  const resources = useQuery({ queryKey: [...appKey(companyId), endpoint?.id, "resources"], queryFn: () => engine.channels.resources(endpoint!.id), enabled: !!endpoint });
  const changeResource = useMutation({ mutationFn: (resource: { id: string; enabled: boolean }) => engine.channels.setResources(endpoint!.id, [resource]), onSuccess: () => void resources.refetch() });
  const test = useMutation({ mutationFn: () => engine.channels.test(endpoint!.id), onSuccess: () => check.mutate() });
  const [removing, setRemoving] = useState(false);
  return <Modal title={`${picked?.app.name ?? provider} agent channel`} onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}><div className="space-y-4">
    <p className="text-sm text-ink-2">{picked?.method.guidanceMd ?? "Manage this agent’s native conversation channel. The engine enforces identity, channel and task permissions."}</p>
    {!endpoint ? <><Field label="Agent" htmlFor="channel-agent"><Select id="channel-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}><option value="">Choose an agent</option>{agents.data?.filter((agent) => agent.status !== "terminated").map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</Select></Field><Button variant="primary" disabled={!agentId} loading={create.isPending} onClick={() => create.mutate()}>Continue to provider setup</Button></> : <>
      <Notice tone={endpoint.status === "active" ? "info" : "warning"}>{endpoint.healthMessage ?? endpoint.status}</Notice>
      <ProviderLink url={endpoint.setup.authorizationUrl ?? endpoint.setup.providerUrl ?? picked?.method.consoleLinks?.register}>Open {provider} setup</ProviderLink>
      {endpoint.setup.webhookUrl && <Field label="Provider callback URL" htmlFor="channel-callback"><Input id="channel-callback" readOnly value={endpoint.setup.webhookUrl} /></Field>}
      <SetupFields fields={fields} values={credentials} setValues={setCredentials} />
      <div className="flex flex-wrap gap-2">{fields.length > 0 && <Button disabled={!!firstFieldError(fields, credentials)} loading={configure.isPending} onClick={() => configure.mutate("configure")}>Save and verify</Button>}<Button loading={check.isPending} onClick={() => { check.mutate(); void resources.refetch(); }}>Check status</Button><Button loading={test.isPending} onClick={() => test.mutate()}>Test channel</Button>{(endpoint.status === "active" || endpoint.status === "paused") && <Button loading={configure.isPending} onClick={() => configure.mutate(endpoint.status === "paused" ? "resume" : "pause")}>{endpoint.status === "paused" ? "Resume" : "Pause"}</Button>}<Button variant="ghost" onClick={() => setRemoving(true)}>Disconnect</Button></div>
      {resources.data && <div className="space-y-3"><p className="text-sm font-medium">Allowed channels</p>{resources.data.length === 0 && <p className="text-xs text-ink-3">No channels discovered yet. Finish provider setup, then check status.</p>}{resources.data.map((resource) => <Toggle key={resource.id} label={resource.label} checked={resource.enabled} disabled={changeResource.isPending} onChange={(enabled) => changeResource.mutate({ id: resource.id, enabled })} />)}</div>}
      <ActionError error={resources.error ?? changeResource.error ?? test.error} />
      {removing && <Notice tone="warning" action={<Button variant="danger" loading={configure.isPending} onClick={() => configure.mutate("remove")}>Disconnect channel</Button>}>Disconnecting stops this channel from creating and continuing agent tasks. <Button size="sm" variant="ghost" onClick={() => setRemoving(false)}>Keep connected</Button></Notice>}
    </>}
    <ActionError error={create.error ?? configure.error ?? check.error ?? agents.error} />
  </div></Modal>;
}
