import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Plus, Send, Trash2 } from "lucide-react";
import { nodeApi, type Values } from "../../data/engine/nodeApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Button, Card, Chip, EmptyState, Field, Notice, PageFrame, PageHeader, Select, Status, Tabs } from "../../ui/primitives.tsx";
import { Async, LiveOnly, ObjectModal, TypedConfirm } from "./common.tsx";

type Tab = "targets" | "matchers";
const TYPES = [["sendmail", "Email through Proxmox's mail server"], ["smtp", "Email through your own SMTP server"], ["gotify", "Gotify"], ["webhook", "Webhook"]] as const;
const TYPE_LABEL: Record<string, string> = { sendmail: "Sendmail", smtp: "SMTP", gotify: "Gotify", webhook: "Webhook" };
const HINTS: Record<string, string> = {
  "from-address": "The address mail comes from.",
  header: "One per line: name=X-Token,value=<base64 of the value>.",
  secret: "One per line: name=token,value=<base64 of the secret>. Secrets are never shown again; list only the names to keep existing ones.",
  body: "The request body, base64 encoded.",
  "match-field": "One per line, such as exact:type=vzdump or regex:hostname=pve.*",
  "match-calendar": "One per line, such as mon..fri 08:00-18:00",
  target: "The targets to notify, one name per line.",
};

function TargetModal({ type, name, onClose, onDone }: { type: string | null; name: string | null; onClose: () => void; onDone: () => void }) {
  const list = useQuery({ queryKey: ["node", "notifications"], queryFn: nodeApi.notifications });
  const [chosen, setChosen] = useState<string>(type ?? "sendmail");
  const detail = useQuery({ queryKey: ["node", "target", type, name], queryFn: () => nodeApi.target(type!, name!), enabled: !!type && !!name });
  if (!list.data || (name && !detail.data)) return null;
  const t = type ?? chosen;
  const schema = list.data.schemas[t as "sendmail"];
  const initial: Values = detail.data?.values ?? {};
  return (
    <ObjectModal
      key={t}
      title={name ? `Edit ${name}` : "Add a notification target"}
      subtitle={TYPE_LABEL[t]}
      schema={schema}
      initial={initial}
      name={name}
      nameLabel="Target name"
      hints={HINTS}
      submitLabel={name ? "Save target" : "Add target"}
      extra={!name ? <Field label="Kind" htmlFor="tgt-kind"><Select id="tgt-kind" value={chosen} onChange={(e) => setChosen(e.target.value)}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field> : detail.data && detail.data.secretsSet.length ? <Notice tone="info">{detail.data.secretsSet.join(", ")} {detail.data.secretsSet.length === 1 ? "is" : "are"} set and never shown. Type a new value to replace {detail.data.secretsSet.length === 1 ? "it" : "them"}.</Notice> : null}
      onSubmit={async (n, values) => {
        if (name) await nodeApi.updateTarget(t, name, values, detail.data?.digest ?? null);
        else await nodeApi.createTarget(t, n, values);
        onDone();
      }}
      onClose={onClose}
    />
  );
}

function MatcherModal({ name, onClose, onDone }: { name: string | null; onClose: () => void; onDone: () => void }) {
  const list = useQuery({ queryKey: ["node", "notifications"], queryFn: nodeApi.notifications });
  const detail = useQuery({ queryKey: ["node", "matcher", name], queryFn: () => nodeApi.matcher(name!), enabled: !!name });
  if (!list.data || (name && !detail.data)) return null;
  return (
    <ObjectModal
      title={name ? `Edit ${name}` : "Add a matcher"}
      subtitle="Chooses which notifications go to which targets."
      schema={list.data.schemas.matcher}
      initial={detail.data?.values ?? { mode: "all" }}
      name={name}
      nameLabel="Matcher name"
      hints={HINTS}
      submitLabel={name ? "Save matcher" : "Add matcher"}
      onSubmit={async (n, values) => {
        if (name) await nodeApi.updateMatcher(name, values, detail.data?.digest ?? null);
        else await nodeApi.createMatcher(n, values);
        onDone();
      }}
      onClose={onClose}
    />
  );
}

function NotificationsBody() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["node", "notifications"], queryFn: nodeApi.notifications, retry: 1 });
  const [tab, setTab] = useState<Tab>("targets");
  const [edit, setEdit] = useState<{ kind: "target"; type: string | null; name: string | null } | { kind: "matcher"; name: string | null } | null>(null);
  const [del, setDel] = useState<{ kind: "target" | "matcher"; type?: string; name: string } | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["node", "notifications"] });
  const test = useMutation({ mutationFn: (name: string) => nodeApi.testTarget(name), onSuccess: (_r, name) => setTested(name) });
  const remove = useMutation({ mutationFn: (d: NonNullable<typeof del>) => (d.kind === "target" ? nodeApi.deleteTarget(d.type!, d.name) : nodeApi.deleteMatcher(d.name)), onSuccess: () => { setDel(null); void refresh(); } });
  return (
    <Async q={q}>
      {(d) => (
        <div className="space-y-4">
          {d.denied && <Notice tone="info">Your Proxmox account can't see notification settings. It needs the Mapping.Audit permission on /mapping/notifications.</Notice>}
          <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "targets", label: "Targets", count: d.targets.length }, { id: "matchers", label: "Matchers", count: d.matchers.length }]} />
          {tested && <Notice tone="good">Sent a test notification through {tested}. Check its inbox or channel.</Notice>}
          {test.error && <Notice tone="critical" title="The test didn't go through">{errorText(test.error)}</Notice>}
          {tab === "targets" ? (
            <>
              <div><Button variant="primary" onClick={() => setEdit({ kind: "target", type: null, name: null })}><Plus className="h-4 w-4" />Add target…</Button></div>
              <Card className="overflow-x-auto edge-fade-x">
                {d.targets.length === 0 ? <EmptyState icon={<BellRing className="h-5 w-5" />} title="No targets" body="A target is where notifications go: an email address, a Gotify server or a webhook." /> : (
                  <table className="w-full text-compact min-w-[560px]">
                    <thead><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">Target</th><th className="font-normal px-3">Kind</th><th className="font-normal px-3">State</th><th className="px-3"><span className="sr-only">Actions</span></th></tr></thead>
                    <tbody>
                      {d.targets.map((t) => (
                        <tr key={t.name} className="border-b border-line last:border-0">
                          <td className="px-4 py-3"><span className="font-mono">{t.name}</span>{t.comment && <span className="block text-xs text-ink-3">{t.comment}</span>}</td>
                          <td className="px-3"><Chip>{TYPE_LABEL[t.type] ?? t.type}</Chip>{t.builtin && <Chip className="ml-1.5">Built in</Chip>}</td>
                          <td className="px-3">{t.disabled ? <Status kind="off" label="Disabled" /> : <Status kind="good" label="On" />}</td>
                          <td className="px-3"><div className="flex gap-1.5 justify-end">
                            <Button size="sm" loading={test.isPending && test.variables === t.name} onClick={() => test.mutate(t.name)}><Send className="h-4 w-4" />Test</Button>
                            {!t.builtin && <Button size="sm" variant="ghost" onClick={() => setEdit({ kind: "target", type: t.type, name: t.name })}>Edit</Button>}
                            {!t.builtin && <Button size="sm" variant="ghost" className="text-critical" aria-label={`Delete ${t.name}`} onClick={() => setDel({ kind: "target", type: t.type, name: t.name })}><Trash2 className="h-4 w-4" /></Button>}
                          </div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </>
          ) : (
            <>
              <div><Button variant="primary" onClick={() => setEdit({ kind: "matcher", name: null })}><Plus className="h-4 w-4" />Add matcher…</Button></div>
              <Card className="overflow-x-auto edge-fade-x">
                {d.matchers.length === 0 ? <EmptyState icon={<BellRing className="h-5 w-5" />} title="No matchers" body="A matcher sends the notifications that fit it (by severity, type or time) to its targets." /> : (
                  <table className="w-full text-compact min-w-[560px]">
                    <thead><tr className="border-b border-line text-ink-3 text-left"><th className="font-normal px-4 h-10">Matcher</th><th className="font-normal px-3">Sends to</th><th className="font-normal px-3">State</th><th className="px-3"><span className="sr-only">Actions</span></th></tr></thead>
                    <tbody>
                      {d.matchers.map((m) => (
                        <tr key={m.name} className="border-b border-line last:border-0">
                          <td className="px-4 py-3"><span className="font-mono">{m.name}</span>{m.builtin && <Chip className="ml-2">Built in</Chip>}</td>
                          <td className="px-3 text-ink-2">{m.targets.length ? m.targets.join(", ") : "No targets"}</td>
                          <td className="px-3">{m.disabled ? <Status kind="off" label="Disabled" /> : <Status kind="good" label="On" />}</td>
                          <td className="px-3"><div className="flex gap-1.5 justify-end"><Button size="sm" variant="ghost" onClick={() => setEdit({ kind: "matcher", name: m.name })}>Edit</Button>{!m.builtin && <Button size="sm" variant="ghost" className="text-critical" aria-label={`Delete ${m.name}`} onClick={() => setDel({ kind: "matcher", name: m.name })}><Trash2 className="h-4 w-4" /></Button>}</div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </>
          )}
          {edit?.kind === "target" && <TargetModal type={edit.type} name={edit.name} onClose={() => setEdit(null)} onDone={() => void refresh()} />}
          {edit?.kind === "matcher" && <MatcherModal name={edit.name} onClose={() => setEdit(null)} onDone={() => void refresh()} />}
          {del && <TypedConfirm title={`Delete ${del.name}?`} phrase={del.name} action={`Delete ${del.kind}`} busy={remove.isPending} error={remove.error ? errorText(remove.error) : null} onClose={() => setDel(null)} onConfirm={() => remove.mutate(del)}><Notice tone="warning">{del.kind === "target" ? "Notifications that used this target stop reaching it." : "Notifications this matcher caught stop being sent to its targets."}</Notice></TypedConfirm>}
        </div>
      )}
    </Async>
  );
}

export function NotificationsPage() {
  return (
    <PageFrame width="6xl">
      <PageHeader title="Notifications" subtitle="Where Proxmox sends its messages (backup results, updates, fencing) and which messages go where." />
      <LiveOnly><NotificationsBody /></LiveOnly>
    </PageFrame>
  );
}
