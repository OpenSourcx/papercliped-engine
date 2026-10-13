import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Radio, Search } from "lucide-react";
import { nodeApi } from "../../data/engine/nodeApi.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Button, Card, Field, Input, Notice, PageFrame, PageHeader, Segmented, Select, Toggle } from "../../ui/primitives.tsx";
import { LiveOnly, NodeSwitcher, TasksLink, useNodeName } from "./common.tsx";

const PAGE = 200;
type Kind = "syslog" | "journal";

function LogView({ lines, search, follow, loading, error, empty }: { lines: string[]; search: string; follow: boolean; loading: boolean; error: unknown; empty: string }) {
  const box = useRef<HTMLPreElement>(null);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  }, [lines, search]);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length, follow]);
  if (error) return <Notice tone="critical" title="Couldn't read the log">{errorText(error)}</Notice>;
  return (
    <>
      <pre ref={box} aria-label="Log lines" aria-busy={loading} className="rounded-lg bg-code border border-line p-3 text-xs leading-relaxed font-mono text-ink-2 h-[min(60vh,560px)] overflow-auto whitespace-pre-wrap break-all">{shown.length ? shown.join("\n") : loading ? "Reading…" : empty}</pre>
      <p className="text-xs text-ink-3 mt-2 tabular-nums">{search.trim() ? `${shown.length} of ${lines.length} lines match “${search.trim()}”` : `${lines.length} ${lines.length === 1 ? "line" : "lines"}`}</p>
    </>
  );
}

function SyslogPane({ node, name, search, follow }: { node?: string; name: string; search: string; follow: boolean }) {
  const [start, setStart] = useState<number | null>(null); // null: the newest page
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [service, setService] = useState("");
  const total = useQuery({ queryKey: ["node", "syslog-total", name, since, until, service], queryFn: () => nodeApi.syslog(node, { limit: 1, start: 0, since: since || undefined, until: until || undefined, service: service || undefined }), refetchInterval: follow ? 3000 : false, retry: 1 });
  const count = total.data?.total ?? null;
  const first = start ?? Math.max(0, (count ?? 0) - PAGE);
  const q = useQuery({
    queryKey: ["node", "syslog", name, first, since, until, service, count],
    queryFn: () => nodeApi.syslog(node, { limit: PAGE, start: first, since: since || undefined, until: until || undefined, service: service || undefined }),
    enabled: count !== null,
    retry: 1,
  });
  useEffect(() => {
    if (follow) setStart(null);
  }, [follow]);
  const lines = (q.data?.lines ?? []).map((l) => l.t);
  const last = Math.min(count ?? 0, first + PAGE);
  return (
    <>
      <div className="grid sm:grid-cols-3 gap-3 mb-3">
        <Field label="From" hint="2026-10-12 or 2026-10-12 08:30" htmlFor="sl-since"><Input id="sl-since" value={since} onChange={(e) => { setSince(e.target.value.trim()); setStart(null); }} placeholder="Any time" className="font-mono" /></Field>
        <Field label="Until" htmlFor="sl-until"><Input id="sl-until" value={until} onChange={(e) => { setUntil(e.target.value.trim()); setStart(null); }} placeholder="Now" className="font-mono" /></Field>
        <Field label="Service" hint="For example pvedaemon" htmlFor="sl-service"><Input id="sl-service" value={service} onChange={(e) => { setService(e.target.value.trim()); setStart(null); }} className="font-mono" spellCheck={false} /></Field>
      </div>
      <LogView lines={lines} search={search} follow={follow} loading={q.isFetching || total.isFetching} error={q.error ?? total.error} empty="No log lines for this range." />
      <div className="flex items-center gap-2 mt-3">
        <Button size="sm" disabled={first <= 0} onClick={() => setStart(Math.max(0, first - PAGE))}><ChevronLeft className="h-4 w-4" />Older</Button>
        <Button size="sm" disabled={count === null || last >= count} onClick={() => setStart(last >= (count ?? 0) - PAGE ? null : last)}>Newer<ChevronRight className="h-4 w-4" /></Button>
        <span className="text-xs text-ink-3 tabular-nums">{count === null ? "" : `Lines ${count ? first + 1 : 0} to ${last} of ${count}`}</span>
        {name && <span className="sr-only">on {name}</span>}
      </div>
    </>
  );
}

const PRIORITIES = [["", "Everything"], ["0..3", "Errors and worse"], ["0..4", "Warnings and worse"], ["0..5", "Notices and worse"], ["0..6", "Without debug"]] as const;
const RANGES = [["", "Latest lines"], ["3600", "Last hour"], ["86400", "Last day"], ["604800", "Last week"]] as const;

function JournalPane({ node, name, search, follow }: { node?: string; name: string; search: string; follow: boolean }) {
  const [lastentries, setLast] = useState(500);
  const [unit, setUnit] = useState("");
  const [priority, setPriority] = useState("");
  const [kernel, setKernel] = useState(false);
  const [range, setRange] = useState("");
  const q = useQuery({
    queryKey: ["node", "journal", name, lastentries, unit, priority, kernel, range],
    queryFn: () => nodeApi.journal(node, { lastentries: range ? undefined : lastentries, since: range ? Math.floor(Date.now() / 1000) - Number(range) : undefined, unit: unit || undefined, priority: priority || undefined, kernel }),
    refetchInterval: follow ? 3000 : false,
    retry: 1,
  });
  return (
    <>
      <div className="grid sm:grid-cols-4 gap-3 mb-3">
        <Field label="Show" htmlFor="jr-range"><Select id="jr-range" value={range} onChange={(e) => setRange(e.target.value)}>{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Field label="Lines" htmlFor="jr-n"><Select id="jr-n" value={lastentries} disabled={!!range} onChange={(e) => setLast(Number(e.target.value))}>{[100, 500, 1000, 2000].map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
        <Field label="Service" hint="A unit such as pveproxy" htmlFor="jr-unit"><Input id="jr-unit" value={unit} onChange={(e) => setUnit(e.target.value.trim())} className="font-mono" spellCheck={false} /></Field>
        <Field label="Importance" htmlFor="jr-pri"><Select id="jr-pri" value={priority} onChange={(e) => setPriority(e.target.value)}>{PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
      </div>
      <div className="flex items-center gap-3 mb-3"><Toggle checked={kernel} onChange={setKernel} label="Kernel messages only" /><span className="text-compact text-ink-2">Kernel messages only</span></div>
      <LogView lines={q.data?.lines ?? []} search={search} follow={follow} loading={q.isFetching} error={q.error} empty="No journal entries match." />
      {name && <span className="sr-only">on {name}</span>}
    </>
  );
}

function LogsBody() {
  const { node, name } = useNodeName();
  const [kind, setKind] = useState<Kind>("journal");
  const [search, setSearch] = useState("");
  const [follow, setFollow] = useState(false);
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-end gap-4 mb-4">
        <Segmented<Kind> label="Log" value={kind} onChange={setKind} options={[{ value: "journal", label: "Journal" }, { value: "syslog", label: "System log" }]} />
        <div className="flex-1 basis-56 min-w-0">
          <label className="sr-only" htmlFor="log-search">Search these lines</label>
          <div className="relative"><Search className="h-4 w-4 text-ink-3 absolute left-3 top-3" aria-hidden /><Input id="log-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search the lines shown" className="pl-9" /></div>
        </div>
        <div className="flex items-center gap-2 h-10"><Toggle checked={follow} onChange={setFollow} label="Follow the end of the log" /><span className="text-compact text-ink-2 inline-flex items-center gap-1.5"><Radio className="h-4 w-4" aria-hidden />Follow</span></div>
      </div>
      {kind === "journal" ? <JournalPane node={node} name={name} search={search} follow={follow} /> : <SyslogPane node={node} name={name} search={search} follow={follow} />}
    </Card>
  );
}

export function LogsPage() {
  const { name, multi } = useNodeName();
  return (
    <PageFrame width="6xl">
      <PageHeader title="Logs" subtitle={`What ${name} has been writing. The journal is the full record; the system log is the classic text log, paged.`} actions={<>{multi && <NodeSwitcher />}<TasksLink /></>} />
      <LiveOnly><LogsBody /></LiveOnly>
    </PageFrame>
  );
}
