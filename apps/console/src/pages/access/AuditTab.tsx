import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { accessAdmin, type AuditFilter } from "../../data/engine/accessAdmin.ts";
import { Button, Input, Select } from "../../ui/primitives.tsx";
import { QueryState, Table, Td, Th, AField as Field } from "./shared.tsx";

const PAGE = 100;
const startOf = (day: string) => (day ? new Date(`${day}T00:00:00`).getTime() : undefined);
const endOf = (day: string) => (day ? new Date(`${day}T23:59:59.999`).getTime() : undefined);

/** Who changed what in access control, and every sign-in. Filter it, then download what you see. */
export function AuditTab() {
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [text, setText] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const filter: AuditFilter = { actor: actor || undefined, action: action || undefined, q: text.trim() || undefined, from: startOf(from), to: endOf(to) };
  const q = useQuery({ queryKey: ["access", "audit", filter, page], queryFn: () => accessAdmin.audit.list({ ...filter, limit: PAGE, offset: page * PAGE }), retry: 0, placeholderData: (p) => p });
  const reset = (set: (v: string) => void) => (v: string) => {
    set(v);
    setPage(0);
  };
  return (
    <div>
      <p className="text-compact text-ink-2 mb-4 max-w-2xl">Kept: sign-ins, changes to users, groups, roles, permissions, realms, tokens and sessions, and API token use. Secrets never appear. The most recent entries are kept.</p>
      <div className="grid sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end mb-4">
        <Field label="Person">
          <Select value={actor} onChange={(e) => reset(setActor)(e.target.value)}><option value="">Everyone</option>{(q.data?.actors ?? []).map((a) => <option key={a} value={a}>{a}</option>)}</Select>
        </Field>
        <Field label="What">
          <Select value={action} onChange={(e) => reset(setAction)(e.target.value)}><option value="">Anything</option>{(q.data?.actions ?? []).map((a) => <option key={a} value={a}>{a}</option>)}</Select>
        </Field>
        <Field label="Search"><Input value={text} onChange={(e) => reset(setText)(e.target.value)} placeholder="name, address, detail" /></Field>
        <Field label="From"><Input type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} /></Field>
        <div className="flex gap-2">
          <a href={accessAdmin.audit.exportUrl("csv", filter)} download className="inline-flex"><Button type="button"><Download className="h-4 w-4" />CSV</Button></a>
          <a href={accessAdmin.audit.exportUrl("json", filter)} download className="inline-flex"><Button type="button"><Download className="h-4 w-4" />JSON</Button></a>
        </div>
      </div>
      <QueryState query={q}>
        {q.data && (
          <>
            <Table min="min-w-[820px]">
              <thead><tr className="border-b border-line"><Th>When</Th><Th>Person</Th><Th>What</Th><Th>About</Th><Th>Detail</Th><Th>Address</Th></tr></thead>
              <tbody>
                {q.data.entries.length === 0 ? <tr><Td className="text-ink-3" >Nothing matches.</Td></tr> : q.data.entries.map((e, i) => (
                  <tr key={`${e.at}-${i}`} className="border-b border-line last:border-0">
                    <Td className="text-ink-2 whitespace-nowrap">{new Date(e.at).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" })}</Td>
                    <Td className="font-mono text-compact">{e.actor}</Td>
                    <Td className="font-mono text-compact">{e.action}</Td>
                    <Td className="text-ink-2 break-all">{e.target ?? ""}</Td>
                    <Td className="text-ink-2 break-words">{e.detail ?? ""}</Td>
                    <Td className="text-ink-3 font-mono text-compact">{e.ip ?? ""}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="flex items-center justify-between mt-3 text-compact text-ink-3">
              <span>{q.data.total} of {q.data.kept} entries match</span>
              <span className="flex gap-2"><Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Newer</Button><Button size="sm" disabled={(page + 1) * PAGE >= q.data.total} onClick={() => setPage(page + 1)}>Older</Button></span>
            </div>
          </>
        )}
      </QueryState>
    </div>
  );
}
