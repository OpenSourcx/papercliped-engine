import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Plus, Trash2 } from "lucide-react";
import { nodeApi, type Values } from "../../data/engine/nodeApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Button, Card, Chip, EmptyState, Field, Notice, PageFrame, PageHeader, Select, Status } from "../../ui/primitives.tsx";
import { Async, LiveOnly, ObjectModal, TypedConfirm } from "./common.tsx";

/** Which of Proxmox's metric-server settings each kind uses. */
const FIELDS: Record<string, string[]> = {
  graphite: ["server", "port", "proto", "path", "timeout", "mtu", "disable"],
  influxdb: ["server", "port", "influxdbproto", "organization", "bucket", "token", "api-path-prefix", "max-body-size", "verify-certificate", "mtu", "timeout", "disable"],
  opentelemetry: ["server", "port", "otel-protocol", "otel-path", "otel-compression", "otel-timeout", "otel-max-body-size", "otel-verify-ssl", "otel-headers", "otel-resource-attributes", "disable"],
};
const KIND: Record<string, string> = { graphite: "Graphite", influxdb: "InfluxDB", opentelemetry: "OpenTelemetry" };
const HINTS: Record<string, string> = { token: "Write-only: saved in Proxmox and never shown again.", "otel-headers": "JSON, base64 encoded. Write-only.", "otel-resource-attributes": "JSON, base64 encoded." };

function MetricModal({ id, onClose, onDone }: { id: string | null; onClose: () => void; onDone: () => void }) {
  const list = useQuery({ queryKey: ["node", "metrics"], queryFn: nodeApi.metrics });
  const detail = useQuery({ queryKey: ["node", "metric", id], queryFn: () => nodeApi.metric(id!), enabled: !!id });
  const [kind, setKind] = useState("graphite");
  if (!list.data || (id && !detail.data)) return null;
  const type = id ? String(detail.data!.values.type ?? "graphite") : kind;
  const initial: Values = detail.data?.values ?? { port: type === "influxdb" ? 8086 : 2003 };
  return (
    <ObjectModal
      key={type}
      title={id ? `Edit ${id}` : "Add a metric server"}
      subtitle={KIND[type]}
      schema={list.data.schema}
      only={FIELDS[type]}
      initial={initial}
      name={id}
      nameLabel="Server name"
      hints={HINTS}
      submitLabel={id ? "Save server" : "Add server"}
      extra={!id ? <Field label="Kind" htmlFor="m-kind"><Select id="m-kind" value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KIND).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field> : detail.data?.hasToken ? <Notice tone="info">An access token is set and never shown. Type a new one to replace it.</Notice> : null}
      onSubmit={async (n, values) => {
        if (id) await nodeApi.updateMetric(id, { ...initial, ...values, type: undefined }, detail.data?.digest ?? null);
        else await nodeApi.createMetric(n, { ...values, type });
        onDone();
      }}
      onClose={onClose}
    />
  );
}

function MetricsBody() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["node", "metrics"], queryFn: nodeApi.metrics, retry: 1 });
  const [edit, setEdit] = useState<string | "new" | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["node", "metrics"] });
  const remove = useMutation({ mutationFn: (id: string) => nodeApi.deleteMetric(id), onSuccess: () => { setDel(null); void refresh(); } });
  return (
    <Async q={q}>
      {(d) => (
        <div className="space-y-4">
          <div><Button variant="primary" onClick={() => setEdit("new")}><Plus className="h-4 w-4" />Add metric server…</Button></div>
          <Card className="overflow-x-auto">
            {d.servers.length === 0 ? <EmptyState icon={<Activity className="h-5 w-5" />} title="No metric servers" body="Proxmox can send CPU, memory, disk and network figures for the device and its machines to Graphite, InfluxDB or an OpenTelemetry collector." /> : (
              <table className="w-full text-compact min-w-[520px]">
                <thead><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">Server</th><th className="font-normal px-3">Kind</th><th className="font-normal px-3">Address</th><th className="font-normal px-3">State</th><th className="px-3"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {d.servers.map((s) => (
                    <tr key={s.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-3 font-mono">{s.id}</td>
                      <td className="px-3"><Chip>{KIND[s.type] ?? s.type}</Chip></td>
                      <td className="px-3 font-mono text-ink-2">{s.server}:{s.port}</td>
                      <td className="px-3">{s.disabled ? <Status kind="off" label="Disabled" /> : <Status kind="good" label="Sending" />}</td>
                      <td className="px-3"><div className="flex gap-1.5 justify-end"><Button size="sm" variant="ghost" onClick={() => setEdit(s.id)}>Edit</Button><Button size="sm" variant="ghost" className="text-critical" aria-label={`Delete ${s.id}`} onClick={() => setDel(s.id)}><Trash2 className="h-4 w-4" /></Button></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          {edit && <MetricModal id={edit === "new" ? null : edit} onClose={() => setEdit(null)} onDone={() => void refresh()} />}
          {del && <TypedConfirm title={`Delete ${del}?`} phrase={del} action="Delete server" busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onClose={() => setDel(null)} onConfirm={() => remove.mutate(del)}><Notice tone="warning">Proxmox stops sending figures to this server. What it already received stays there.</Notice></TypedConfirm>}
        </div>
      )}
    </Async>
  );
}

export function MetricsPage() {
  return (
    <PageFrame width="6xl">
      <PageHeader title="Metric servers" subtitle="Send this datacenter's figures to Graphite, InfluxDB or an OpenTelemetry collector, for dashboards and alerts elsewhere." />
      <LiveOnly><MetricsBody /></LiveOnly>
    </PageFrame>
  );
}
