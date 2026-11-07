import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import type { ChatEndpoint, ConnectToolAppResult, FieldDef, ToolCatalogEntry } from "@papercliped-engine/engine-client";
import { engine, useAgents } from "../../../data/engine/queries.ts";
import { nativeAppApi } from "../../../data/engine/connectApi.ts";
import { httpUrl } from "../../../lib/safeUrl.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { ProviderMark } from "../../../ui/ProviderMark.tsx";
import { Button, Field, Input, Notice, Select, Toggle } from "../../../ui/primitives.tsx";
import { ActionError, LoadError, Loading } from "./common.tsx";
import { appKey, type PickedApp } from "./LiveOrganizationApps.tsx";

function ProviderLink({ url, children }: { url?: string | null; children: ReactNode }) {
  const href = url && httpUrl(url);
  return href ? <a href={httpUrl(url) ?? undefined} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-compact text-accent hover:underline">{children}<ExternalLink className="h-3.5 w-3.5" /></a> : null;
}

function SetupFields({ fields, values, setValues }: { fields: FieldDef[]; values: Record<string, string>; setValues: (value: Record<string, string>) => void }) {
  return <>{fields.filter((field) => !field.hidden).map((field) => <Field key={field.key} label={`${field.label}${field.required ? " *" : ""}`} htmlFor={`app-${field.key}`} hint={field.helperMd}>
    {field.type === "select" ? <Select id={`app-${field.key}`} value={values[field.key] ?? String(field.defaultValue ?? "")} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}><option value="">Choose…</option>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select> : <Input id={`app-${field.key}`} type={field.secret || field.type === "password" ? "password" : "text"} autoComplete="off" value={values[field.key] ?? ""} placeholder={field.placeholder} onChange={(e) => setValues({ ...values, [field.key]: e.target.value })} />}
  </Field>)}</>;
}

export function AppSetup({ companyId, picked: { app, method }, onClose, onReview }: { companyId: string; picked: PickedApp; onClose: () => void; onReview: (id: string) => void }) {
  const address = useQuery({ queryKey: ["native-apps", "status"], queryFn: nativeAppApi.status, enabled: method.auth === "oauth" });
  const callback = address.data?.callbackUrl;
  const oauthReady = method.auth !== "oauth" || !!callback && new URL(callback).origin === window.location.origin;
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ConnectToolAppResult | null>(null);
  const connect = useMutation({ mutationFn: () => engine.apps.connect(companyId, { galleryKey: app.slug, connectionMethodKey: method.key, grantKind: "organization", credentialValues: credentials, configValues: config }), onSuccess: (value) => { setCredentials({}); setResult(value); if (!value.auth) onReview(value.connectionId); } });
  return <Modal title={`Connect ${app.name}`} icon={<ProviderMark id={app.slug} name={app.name} />} onClose={onClose} footer={<><Button onClick={onClose}>Close</Button>{result ? <Button variant="primary" onClick={() => onReview(result.connectionId)}>Review agent access</Button> : <Button variant="primary" disabled={!oauthReady} loading={connect.isPending} onClick={() => connect.mutate()}>{method.auth === "oauth" ? `Sign in with ${app.name}` : "Connect"}</Button>}</>}>
    <div className="space-y-4"><p className="text-sm text-ink-2">{method.whenToUse}</p><p className="text-compact text-ink-3">{method.guidanceMd}</p>
      <ProviderLink url={method.consoleLinks?.register ?? method.consoleLinks?.keys ?? method.consoleLinks?.docs}>Open {app.name} setup</ProviderLink>
      {method.auth === "oauth" && !oauthReady && address.data && <Notice tone="warning">This device’s provider sign-in address does not match the console address. A device administrator must configure its public address before browser sign-in can work.</Notice>}
      <ActionError error={address.error} />
      {!result && <><SetupFields fields={method.tenantFields ?? []} values={config} setValues={setConfig} /><SetupFields fields={method.credentialFields ?? []} values={credentials} setValues={setCredentials} /></>}
      {result?.auth && <Notice tone="info">{result.auth.manualClientRequired ? "This provider requires a registered OAuth client. Setup must be completed before agents can use it." : <>Finish sign-in on the provider’s page, then return to review access. <ProviderLink url={result.auth.startUrl}>Continue to {app.name}</ProviderLink></>}</Notice>}
      <ActionError error={connect.error} />
    </div>
  </Modal>;
}

export function ToolReview({ companyId, connectionId, onClose }: { companyId: string; connectionId: string; onClose: () => void }) {
  const agents = useAgents(companyId);
  const catalog = useQuery({ queryKey: [...appKey(companyId), connectionId, "catalog"], queryFn: () => engine.apps.catalog(connectionId) });
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [policies, setPolicies] = useState<Record<string, "off" | "ask" | "allow">>({});
  const policy = (entry: ToolCatalogEntry) => entry.status === "disabled" ? "off" : policies[entry.id] ?? "off";
  const save = useMutation({ mutationFn: () => engine.apps.finish(companyId, connectionId, { preserveExistingAccess: false, access: { agentIds }, enabledCatalogEntryIds: (catalog.data?.catalog ?? []).filter((entry) => policy(entry) !== "off").map((entry) => entry.id), askFirstCatalogEntryIds: (catalog.data?.catalog ?? []).filter((entry) => policy(entry) === "ask").map((entry) => entry.id), reviewedCatalogEntryIds: (catalog.data?.catalog ?? []).filter((entry) => entry.status === "quarantined").map((entry) => entry.id) }), onSuccess: onClose });
  const refresh = useMutation({ mutationFn: () => engine.apps.refresh(connectionId), onSuccess: () => void catalog.refetch() });
  return <Modal title="Set agent access" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!catalog.data || !agents.data || refresh.isPending} onClick={() => save.mutate()}>Replace access</Button></>}>
    <div className="space-y-4"><Notice tone="warning">Saving replaces this connection’s agent assignments and action policies. Nothing is selected initially. Choose the agents and actions you want to keep.</Notice>
      {agents.error && <LoadError error={agents.error} retry={() => void agents.refetch()} />}
      {agents.data?.filter((agent) => agent.status !== "terminated").map((agent) => <Toggle key={agent.id} label={agent.name} checked={agentIds.includes(agent.id)} onChange={(checked) => setAgentIds((ids) => checked ? [...ids, agent.id] : ids.filter((id) => id !== agent.id))} />)}
      <Button size="sm" loading={refresh.isPending} onClick={() => refresh.mutate()}>Refresh available actions</Button>
      {catalog.isPending && <Loading />}{catalog.error && <LoadError error={catalog.error} retry={() => void catalog.refetch()} />}
      {catalog.data?.catalog.length === 0 && <p className="text-sm text-ink-3">No actions discovered. Finish provider sign-in, then refresh.</p>}
      {catalog.data?.catalog.map((entry) => <Field key={entry.id} label={entry.title ?? entry.toolName} htmlFor={`policy-${entry.id}`} hint={entry.status === "disabled" ? "Unavailable at the provider" : entry.isDestructive ? "Destructive action" : entry.isReadOnly ? "Read only" : "Can change provider data"}><p className="mb-2 text-xs text-ink-3">{entry.description}</p><Select id={`policy-${entry.id}`} value={policy(entry)} disabled={entry.status === "disabled"} onChange={(e) => setPolicies({ ...policies, [entry.id]: e.target.value as "off" | "ask" | "allow" })}><option value="off">Off</option><option value="ask">Ask for approval</option><option value="allow">Allow</option></Select></Field>)}
      <ActionError error={save.error ?? refresh.error} />
    </div>
  </Modal>;
}

export function ChannelSetup({ companyId, picked, existing, onClose }: { companyId: string; picked?: PickedApp; existing?: ChatEndpoint; onClose: () => void }) {
  const agents = useAgents(companyId);
  const [agentId, setAgentId] = useState("");
  const [endpoint, setEndpoint] = useState(existing ?? null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const provider = picked?.method.provider ?? existing?.provider;
  const fields = picked?.method.credentialFields ?? [];
  const create = useMutation({ mutationFn: () => engine.channels.create(companyId, { provider: provider as "slack" | "discord", assignedAgentId: agentId }), onSuccess: setEndpoint });
  const configure = useMutation({ mutationFn: (action: "configure" | "verify" | "pause" | "resume" | "remove") => engine.channels.configure(endpoint!.id, { action, ...(action === "configure" ? { credentials } : {}) }), onSuccess: (value, action) => { setCredentials({}); if (action === "remove") onClose(); else setEndpoint(value); } });
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
      <div className="flex flex-wrap gap-2">{fields.length > 0 && <Button disabled={fields.some((field) => field.required && !credentials[field.key]?.trim())} loading={configure.isPending} onClick={() => configure.mutate("configure")}>Save and verify</Button>}<Button loading={check.isPending} onClick={() => { check.mutate(); void resources.refetch(); }}>Check status</Button><Button loading={test.isPending} onClick={() => test.mutate()}>Test channel</Button>{(endpoint.status === "active" || endpoint.status === "paused") && <Button loading={configure.isPending} onClick={() => configure.mutate(endpoint.status === "paused" ? "resume" : "pause")}>{endpoint.status === "paused" ? "Resume" : "Pause"}</Button>}<Button variant="ghost" onClick={() => setRemoving(true)}>Disconnect</Button></div>
      {resources.data && <div className="space-y-3"><p className="text-sm font-medium">Allowed channels</p>{resources.data.length === 0 && <p className="text-xs text-ink-3">No channels discovered yet. Finish provider setup, then check status.</p>}{resources.data.map((resource) => <Toggle key={resource.id} label={resource.label} checked={resource.enabled} disabled={changeResource.isPending} onChange={(enabled) => changeResource.mutate({ id: resource.id, enabled })} />)}</div>}
      <ActionError error={resources.error ?? changeResource.error ?? test.error} />
      {removing && <Notice tone="warning" action={<Button variant="danger" loading={configure.isPending} onClick={() => configure.mutate("remove")}>Disconnect channel</Button>}>Disconnecting stops this channel from creating and continuing agent tasks. <Button size="sm" variant="ghost" onClick={() => setRemoving(false)}>Keep connected</Button></Notice>}
    </>}
    <ActionError error={create.error ?? configure.error ?? check.error ?? agents.error} />
  </div></Modal>;
}
