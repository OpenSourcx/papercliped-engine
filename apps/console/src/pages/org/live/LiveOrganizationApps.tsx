import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { AppDefinition, ChatEndpoint, ConnectionMethodDef, ToolConnection } from "@papercliped-engine/engine-client";
import { engine } from "../../../data/engine/queries.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { ProviderMark } from "../../../ui/ProviderMark.tsx";
import { Button, Card, PageFrame, PageHeader, Status } from "../../../ui/primitives.tsx";
import { ActionError, LoadError, Loading, useLiveOrg } from "./common.tsx";
import { AppSetup, ChannelSetup, ToolReview } from "./OrganizationAppSetup.tsx";
import { ConnectionRow } from "./ConnectionRow.tsx";

const CORE = new Set(["github", "discord", "slack", "notion", "vercel"]);
export const appKey = (companyId: string) => ["engine", "co", companyId, "apps"];
export type PickedApp = { app: AppDefinition; method: ConnectionMethodDef };

/** Uses the pinned engine's native connection, channel and tool-governance backends. */
export function LiveOrganizationApps() {
  const { companyId } = useLiveOrg();
  const qc = useQueryClient();
  const gallery = useQuery({ queryKey: [...appKey(companyId), "gallery"], queryFn: () => engine.apps.gallery(companyId) });
  const connections = useQuery({ queryKey: [...appKey(companyId), "connections"], queryFn: () => engine.apps.list(companyId) });
  const channels = useQuery({ queryKey: [...appKey(companyId), "channels"], queryFn: () => engine.channels.list(companyId) });
  const [picked, setPicked] = useState<PickedApp | null>(null);
  const [review, setReview] = useState<string | null>(null);
  const [channel, setChannel] = useState<ChatEndpoint | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: appKey(companyId) });
  const canManage = gallery.data?.capabilities.canCreateOrganizationGrant === true;
  return <PageFrame width="4xl"><PageHeader title="Organization apps" subtitle="Connect a provider, choose its agents, then review which actions they can use." />
    {[gallery, connections, channels].some((q) => q.isPending) && <Card><Loading label="Loading apps" /></Card>}
    {[gallery, connections, channels].filter((q) => q.error).map((q, i) => <Card key={i}><LoadError error={q.error} retry={() => void q.refetch()} /></Card>)}
    <div className="grid gap-3 sm:grid-cols-2">{gallery.data?.apps.filter((app) => CORE.has(app.slug)).map((app) => <Card key={app.slug} className="p-5">
      <div className="flex items-center gap-3"><ProviderMark id={app.slug} name={app.name} /><h3 className="font-medium">{app.name}</h3></div>
      <p className="mt-3 text-compact text-ink-2">{app.description}</p>
      {app.availability?.available === false && <p className="mt-2 text-xs text-warning">{app.availability.reason ?? "Setup is unavailable on this device."}</p>}
      <div className="mt-4 flex flex-wrap gap-2">{app.methods.filter((method) => method.purpose !== "ai" && method.transport !== "runtime_auth").map((method) => <Button key={method.key} size="sm" disabled={!canManage || app.availability?.available === false} onClick={() => setPicked({ app, method })}><Plus className="h-3.5 w-3.5" />{method.label ?? (method.auth === "oauth" ? `Connect ${app.name}` : "Set up")}</Button>)}</div>
    </Card>)}</div>
    {gallery.data && !canManage && <p className="mt-3 text-compact text-ink-3">{gallery.data.capabilities.organizationGrantReason ?? "An organization connection manager can connect apps."}</p>}
    <div className="mt-6 space-y-3">{connections.data?.connections.filter((connection) => connection.transport !== "chat_sdk" && connection.transport !== "runtime_auth").map((connection) => <ConnectionRow key={connection.id} apps={gallery.data?.apps ?? []} connection={connection} canManage={canManage} onReview={() => setReview(connection.id)} refresh={refresh} />)}
      {channels.data?.map((endpoint) => <Card key={endpoint.id} className="flex items-center gap-3 p-4"><ProviderMark id={endpoint.provider} name={endpoint.provider} /><div className="flex-1"><div className="font-medium capitalize">{endpoint.provider}</div><div className="text-xs text-ink-3">{endpoint.assignedAgentName ?? "Assigned agent"} · {endpoint.healthMessage ?? endpoint.status}</div></div><Button size="sm" disabled={!canManage} onClick={() => setChannel(endpoint)}>Manage</Button></Card>)}
    </div>
    {picked && (picked.method.purpose === "channel" || picked.method.transport === "chat_sdk" ? <ChannelSetup companyId={companyId} picked={picked} onClose={() => { setPicked(null); refresh(); }} /> : <AppSetup companyId={companyId} picked={picked} onClose={() => { setPicked(null); refresh(); }} onReview={(id) => { setPicked(null); setReview(id); refresh(); }} />)}
    {review && <ToolReview companyId={companyId} connectionId={review} onClose={() => { setReview(null); refresh(); }} />}
    {channel && <ChannelSetup companyId={companyId} existing={channel} picked={(() => { const app = gallery.data?.apps.find((item) => item.slug === channel.provider); const method = app?.methods.find((item) => item.provider === channel.provider && item.transport === "chat_sdk"); return app && method ? { app, method } : undefined; })()} onClose={() => { setChannel(null); refresh(); }} />}
  </PageFrame>;
}
