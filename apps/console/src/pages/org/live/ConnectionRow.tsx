import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AppDefinition, ToolConnection } from "@papercliped-engine/engine-client";
import { engine } from "../../../data/engine/queries.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { ProviderMark } from "../../../ui/ProviderMark.tsx";
import { Button, Card, Status } from "../../../ui/primitives.tsx";
import { ActionError } from "./common.tsx";

/** Which gallery app a connection belongs to: its recorded gallery key if the engine stored one, else the app whose name its name starts with. */
export function appForConnection(connection: ToolConnection, apps: AppDefinition[]): AppDefinition | undefined {
  const key = [connection.config?.galleryKey, connection.transportConfig?.galleryKey].find((v): v is string => typeof v === "string");
  if (key) return apps.find((app) => app.slug === key);
  const name = connection.name.trim().toLowerCase();
  return apps.find((app) => name === app.name.toLowerCase() || name.startsWith(`${app.name.toLowerCase()} `) || name.startsWith(`${app.name.toLowerCase()}:`));
}

const when = (value?: Date | string | null) => { const t = value ? new Date(value).getTime() : NaN; return Number.isNaN(t) ? null : new Date(t).toLocaleString(); };

/** One connected app: provider mark, health (never colour alone), actions available, refresh, reauthorize, and revoke. */
export function ConnectionRow({ connection, apps, canManage, onReview, refresh }: { connection: ToolConnection; apps: AppDefinition[]; canManage: boolean; onReview: () => void; refresh: () => void }) {
  const app = appForConnection(connection, apps);
  const catalog = useQuery({ queryKey: ["engine", "connection", connection.id, "catalog-count"], queryFn: () => engine.apps.catalog(connection.id), staleTime: 60_000 });
  const health = useMutation({ mutationFn: () => engine.apps.health(connection.id), onSuccess: refresh });
  const refreshCatalog = useMutation({ mutationFn: () => engine.apps.refresh(connection.id), onSuccess: () => { void catalog.refetch(); refresh(); } });
  const [removing, setRemoving] = useState(false);
  const remove = useMutation({ mutationFn: () => engine.apps.remove(connection.id), onSuccess: refresh });
  const reauth = connection.requiresReauthorization === true;
  const healthy = connection.healthStatus === "healthy" && !reauth;
  const label = !connection.enabled ? "Disabled" : reauth ? "Sign in again" : connection.healthStatus.replaceAll("_", " ");
  const actions = catalog.data?.catalog.filter((entry) => entry.status !== "disabled").length;
  const checked = when(connection.healthCheckedAt ?? connection.lastHealthAt);
  return <Card className="p-4">
    <div className="flex flex-wrap items-center gap-3">
      <ProviderMark id={app?.slug ?? connection.name.toLowerCase()} name={app?.name ?? connection.name} />
      <div className="min-w-0 flex-1 basis-48"><div className="truncate font-medium">{connection.name}</div>
        <div className="text-xs text-ink-3">{connection.healthMessage ?? connection.lastError}{checked ? `${connection.healthMessage || connection.lastError ? " · " : ""}Checked ${checked}` : ""}{actions !== undefined ? ` · ${actions} action${actions === 1 ? "" : "s"} available` : ""}</div></div>
      <Status kind={healthy ? "good" : "warning"} label={label} />
    </div>
    {canManage && <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" onClick={onReview}>Agent access</Button><Button size="sm" loading={health.isPending} onClick={() => health.mutate()}>Check connection</Button><Button size="sm" loading={refreshCatalog.isPending} onClick={() => refreshCatalog.mutate()}>Refresh actions</Button><Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>Disconnect</Button></div>}
    <ActionError error={health.error ?? refreshCatalog.error ?? remove.error} />
    {removing && <Modal title={`Disconnect ${connection.name}?`} onClose={() => setRemoving(false)} footer={<><Button onClick={() => setRemoving(false)}>Cancel</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Revoke and disconnect</Button></>}><p className="text-sm text-ink-2">The engine will revoke this connection and every agent’s access to it. Running work that needs it may fail. You can connect it again later and choose access again.</p><ActionError error={remove.error} /></Modal>}
  </Card>;
}
