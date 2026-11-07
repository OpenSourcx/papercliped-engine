import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { engine } from "../../../data/engine/queries.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { Button, Card, Status } from "../../../ui/primitives.tsx";
import { ActionError, LoadError, Loading } from "./common.tsx";

/** App actions the engine is holding for a person: an agent or Pin asked, and the organization's policy says ask first. A person decides here; the engine then runs or drops the call. */
export function HeldAppActions({ companyId, canDecide }: { companyId: string; canDecide: boolean }) {
  const qc = useQueryClient();
  const key = ["engine", "co", companyId, "apps", "held"];
  const held = useQuery({ queryKey: key, queryFn: () => engine.apps.actionRequests(companyId), refetchInterval: 15_000 });
  const done = () => void qc.invalidateQueries({ queryKey: key });
  const [deciding, setDeciding] = useState<{ id: string; verb: "approve" | "decline"; label: string } | null>(null);
  const decide = useMutation({ mutationFn: (d: NonNullable<typeof deciding>) => (d.verb === "approve" ? engine.apps.approveAction(d.id, companyId) : engine.apps.declineAction(d.id, companyId)), onSuccess: () => { setDeciding(null); done(); } });
  const items = held.data?.actionRequests ?? [];
  return <Card className="mt-6 p-5" aria-labelledby="held-actions"><h3 id="held-actions" className="font-medium">Held app actions</h3>
    <p className="mt-1 text-compact text-ink-3">Actions waiting for a person. Approving lets the engine run the action once with the arguments shown; declining drops it.</p>
    {held.isPending && <Loading />}{held.error && <LoadError error={held.error} retry={() => void held.refetch()} />}
    {held.data && items.length === 0 && <p className="mt-3 text-compact text-ink-3">Nothing is waiting.</p>}
    <div className="mt-3 space-y-3">{items.map((a) => { const label = a.toolTitle ?? a.toolName; return <div key={a.request.id} className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1 basis-48"><div className="font-medium">{label}</div><div className="text-xs text-ink-3">{a.connectionName ?? a.applicationName}{a.riskLevel ? ` · ${a.riskLevel}` : ""}{a.request.expiresAt ? ` · expires ${new Date(a.request.expiresAt).toLocaleString()}` : ""}</div></div><Status kind="warning" label="Waiting" /></div>
      <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code p-2 font-mono text-xs">{a.request.canonicalArgumentsSummary?.summary ?? a.request.previewMarkdown ?? "No arguments."}</pre>
      {canDecide && <div className="mt-2 flex flex-wrap gap-2"><Button variant="primary" onClick={() => setDeciding({ id: a.request.id, verb: "approve", label })}>Approve</Button><Button variant="ghost" onClick={() => setDeciding({ id: a.request.id, verb: "decline", label })}>Decline</Button></div>}
    </div>; })}</div>
    {deciding && <Modal title={`${deciding.verb === "approve" ? "Approve" : "Decline"} ${deciding.label}?`} onClose={() => setDeciding(null)} footer={<><Button onClick={() => setDeciding(null)}>Cancel</Button><Button variant={deciding.verb === "approve" ? "primary" : "danger"} loading={decide.isPending} onClick={() => decide.mutate(deciding)}>{deciding.verb === "approve" ? "Approve and run" : "Decline"}</Button></>}>
      <p className="text-sm text-ink-2">{deciding.verb === "approve" ? "The engine will run this action now with exactly the arguments shown." : "The action is dropped and nothing runs."}</p><ActionError error={decide.error} /></Modal>}
  </Card>;
}
