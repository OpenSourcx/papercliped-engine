import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { describeRule } from "@papercliped-engine/automations";
import { ArrowUp, Archive, BookOpen, Bot, Boxes, Building2, Cable, Check, Eye, FileText, HardDrive, Lightbulb, Network, Pencil, RotateCcw, Save, Sparkles, Workflow, Zap } from "lucide-react";
import { useEngine } from "../../data/store.tsx";
import { DEFAULT_MEMORY, DEFAULT_SOUL } from "../../data/pin.ts";
import type { PinLogEntry } from "../../data/types.ts";
import { cn } from "../../lib/storage.ts";
import { PinCardView } from "../../pin/PinCards.tsx";
import { usePin, usePinActions } from "../../pin/PinContext.tsx";
import { PinOrb } from "../../pin/PinIsland.tsx";
import { Button, Card, Chip, PageFrame, Segmented, Toggle } from "../../ui/primitives.tsx";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "chat", label: "Chat" },
  { id: "memory", label: "Soul and memory" },
  { id: "automations", label: "Automations" },
  { id: "activity", label: "Activity" },
  { id: "skills", label: "Skills" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

const LOG_ICON: Record<PinLogEntry["kind"], ReactNode> = {
  did: <Check className="h-3.5 w-3.5 text-good" />,
  proposed: <Lightbulb className="h-3.5 w-3.5 text-warning" />,
  learned: <BookOpen className="h-3.5 w-3.5 text-accent" />,
  changed: <Pencil className="h-3.5 w-3.5 text-ink-3" />,
};
const LOG_LABEL: Record<PinLogEntry["kind"], string> = { did: "Did", proposed: "Proposed", learned: "Learned", changed: "Changed" };

/** Pin's own page: who it is, what it can touch, what it remembers, what it runs and what it has done. */
export function PinPage() {
  const engine = useEngine();
  const pin = usePin();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.some((t) => t.id === params.get("tab")) ? (params.get("tab") as Tab) : "overview";
  const setTab = (t: Tab) => setParams((p) => { const n = new URLSearchParams(p); if (t === "overview") n.delete("tab"); else n.set("tab", t); return n; }, { replace: true });
  const mode = engine.setup?.pinMode ?? "assistant";
  const access = engine.setup?.pinAccess ?? { system: true, orgs: true, connectors: true, docs: true };
  const activeRules = engine.data.rules.filter((r) => r.enabled).length;
  const last = engine.pin.log[0];
  const device = engine.setup?.deviceName ?? "pve";

  usePinActions({
    context: "Pin",
    items: [
      { id: "pin-chat", label: "Chat", icon: <Sparkles className="h-4 w-4" />, group: "do", run: () => setTab("chat") },
      { id: "pin-automation", label: "New automation", icon: <Zap className="h-4 w-4" />, group: "do", run: () => { setTab("chat"); pin.send("If a container uses more than 50% of its memory, shut it down", { inPlace: true }); } },
      { id: "pin-memory", label: "Edit memory", icon: <BookOpen className="h-4 w-4" />, group: "do", run: () => setTab("memory") },
      { id: "pin-status", label: "How is my server?", icon: <Sparkles className="h-4 w-4" />, group: "ask", run: () => { setTab("chat"); pin.send("How is my server?", { inPlace: true }); } },
    ],
  }, 10);

  return (
    <PageFrame width="6xl">
      <div className="relative rounded-2xl border border-line overflow-hidden mb-6">
        <div className="absolute inset-0 hero-glow opacity-70 pointer-events-none" aria-hidden />
        <div className="relative flex flex-wrap items-center gap-5 p-6">
          <PinOrb size={64} thinking={pin.thinking} />
          <div className="flex-1 min-w-[220px]">
            <h1 className="text-[28px] font-semibold tracking-tight leading-tight">Pin</h1>
            <p className="text-[14px] text-ink-2 mt-1">
              {mode === "agent" ? "Agent mode: acts on its own and tells you after." : "Assistant mode: asks before it changes anything."} Watching {device} · {activeRules} automation{activeRules === 1 ? "" : "s"} on{last ? ` · last ${LOG_LABEL[last.kind].toLowerCase()} ${ago(last.at)}` : ""}
            </p>
          </div>
          <Segmented value={mode} onChange={(m) => engine.setPinMode(m)} options={[{ value: "assistant", label: "Assistant" }, { value: "agent", label: "Agent" }]} />
        </div>
      </div>

      <div className="flex gap-1 border-b border-line mb-5 overflow-x-auto [scrollbar-width:none]" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("px-3.5 h-10 text-[14px] whitespace-nowrap border-b-2 -mb-px transition", tab === t.id ? "border-accent text-ink" : "border-transparent text-ink-3 hover:text-ink-2")}>{t.label}</button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid lg:grid-cols-[1fr_340px] gap-5 fade-in">
          <div className="space-y-5">
            <Card className="p-5">
              <h2 className="font-medium mb-1">What Pin may do</h2>
              <p className="text-[13px] text-ink-3 mb-4">Switch off anything you'd rather handle yourself. Pin never deletes machines, backups or data, whatever is on here.</p>
              <div className="divide-y divide-line">
                {([
                  ["system", <Boxes key="s" className="h-4 w-4" />, "Manage this device", "Start, stop and snapshot machines, run backups, watch resources."],
                  ["orgs", <Building2 key="o" className="h-4 w-4" />, "Manage organizations", "Create organizations, size their resource groups, help their agents."],
                  ["connectors", <Cable key="c" className="h-4 w-4" />, "Use connectors", "Use the system-wide connectors you've shared with Pin."],
                  ["docs", <BookOpen key="d" className="h-4 w-4" />, "Read the Proxmox docs", "Look things up in the Proxmox VE documentation when answering."],
                ] as const).map(([k, icon, title, body]) => (
                  <div key={k} className="flex items-center gap-3 py-3">
                    <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2 shrink-0">{icon}</span>
                    <div className="flex-1 min-w-0"><div className="text-[14px] font-medium">{title}</div><div className="text-[12px] text-ink-3">{body}</div></div>
                    <Toggle checked={access[k]} onChange={(v) => engine.setPinAccess({ [k]: v })} label={title} />
                  </div>
                ))}
              </div>
            </Card>
            <Card className="p-5">
              <div className="flex items-center justify-between mb-3"><h2 className="font-medium">Recent activity</h2><button onClick={() => setTab("activity")} className="text-[13px] text-ink-3 hover:text-ink">All activity</button></div>
              <ActivityList entries={engine.pin.log.slice(0, 5)} />
            </Card>
          </div>
          <div className="space-y-5">
            <Card className="p-5">
              <h2 className="font-medium mb-3">Pin's files</h2>
              {([["soul", "SOUL.md", "Who Pin is and how it behaves"], ["memory", "MEMORY.md", "What it has learned about you"]] as const).map(([k, file, body]) => (
                <button key={k} onClick={() => setTab("memory")} className="w-full text-left rounded-lg border border-line p-3 mb-2 last:mb-0 hover:border-line-strong transition">
                  <div className="flex items-center gap-2 font-mono text-[13px]"><FileText className="h-4 w-4 text-ink-3" />{file}</div>
                  <div className="text-[12px] text-ink-3 mt-1">{body}{engine.pin.editedAt[k] ? ` · edited ${ago(engine.pin.editedAt[k]!)}` : ""}</div>
                </button>
              ))}
            </Card>
            <Card className="p-5">
              <div className="flex items-center justify-between mb-3"><h2 className="font-medium">Connectors</h2><Link to="?settings=connectors" className="text-[13px] text-ink-3 hover:text-ink">Manage</Link></div>
              {engine.data.connectors.length === 0 ? (
                <p className="text-[13px] text-ink-3">No connectors yet.</p>
              ) : (
                <div className="space-y-2">
                  {engine.data.connectors.map((c) => (
                    <div key={c.id} className="flex items-center gap-3">
                      <span className="flex-1 text-[13px] truncate">{c.name}{c.status !== "connected" && <span className="text-ink-3"> · needs setup</span>}</span>
                      <Toggle checked={c.access.pin} disabled={!access.connectors} onChange={(v) => engine.setConnectorAccess(c.id, "pin", v)} label={`Let Pin use ${c.name}`} />
                    </div>
                  ))}
                  {!access.connectors && <p className="text-[12px] text-ink-3">Turn on "Use connectors" to share them with Pin.</p>}
                </div>
              )}
            </Card>
            <Card className="p-5">
              <div className="flex items-center justify-between mb-2"><h2 className="font-medium">Automations</h2><button onClick={() => setTab("automations")} className="text-[13px] text-ink-3 hover:text-ink">Open</button></div>
              <p className="text-[13px] text-ink-2">{activeRules} on, {engine.data.rules.length - activeRules} off.</p>
              <Button size="sm" className="mt-3" onClick={() => { setTab("chat"); pin.send("If a container uses more than 50% of its memory, shut it down", { inPlace: true }); }}><Zap className="h-3.5 w-3.5" />New with Pin</Button>
            </Card>
          </div>
        </div>
      )}

      {tab === "chat" && <PinChat />}
      {tab === "memory" && <PinFiles />}
      {tab === "automations" && (
        <div className="space-y-3 fade-in">
          <div className="flex items-center justify-between">
            <p className="text-[13px] text-ink-3">Rules Pin runs for you. {mode === "assistant" ? "In Assistant mode, a firing rule asks you first." : "In Agent mode, a firing rule acts and tells you after."}</p>
            <Button size="sm" variant="primary" onClick={() => { setTab("chat"); pin.send("If a container uses more than 50% of its memory, shut it down", { inPlace: true }); }}><Sparkles className="h-3.5 w-3.5" />New with Pin</Button>
          </div>
          {engine.data.rules.length === 0 && <Card className="p-8 text-center text-ink-3 text-[14px]">No automations yet. Tell Pin what you want in plain words.</Card>}
          {engine.data.rules.map((r) => (
            <Card key={r.id} className="p-4 flex items-start gap-4">
              <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2 shrink-0"><Workflow className="h-4 w-4" /></span>
              <div className="flex-1 min-w-0">
                <p className="text-[14px]">{describeRule(r)}</p>
                <div className="font-mono text-[11px] text-ink-3 mt-1">{r.when.metric} {r.when.op} {String(r.when.value)} · {r.then.action}</div>
              </div>
              {r.createdBy === "pin" && <Chip tone="accent">By Pin</Chip>}
              <Toggle checked={r.enabled} onChange={() => engine.toggleRule(r.id)} label={`Enable ${r.name}`} />
            </Card>
          ))}
          <p className="text-[12px] text-ink-3">Also on the <Link to={`/${device}/automations`} className="text-accent hover:underline">Automations</Link> page.</p>
        </div>
      )}
      {tab === "activity" && (
        <Card className="p-5 fade-in">
          <p className="text-[13px] text-ink-3 mb-4">Everything Pin did, proposed or learned, and every change you made to how it works. Newest first.</p>
          <ActivityList entries={engine.pin.log} />
        </Card>
      )}
      {tab === "skills" && <PinSkills onAsk={(q) => { setTab("chat"); pin.send(q, { inPlace: true }); }} onGo={(to) => nav(to)} />}
    </PageFrame>
  );
}

function ActivityList({ entries }: { entries: PinLogEntry[] }) {
  if (!entries.length) return <p className="text-[13px] text-ink-3">Nothing yet.</p>;
  return (
    <ol className="space-y-3">
      {entries.map((e) => (
        <li key={e.id} className="flex gap-3">
          <span className="h-6 w-6 rounded-full bg-surface-2 flex items-center justify-center shrink-0 mt-0.5" title={LOG_LABEL[e.kind]}>{LOG_ICON[e.kind]}</span>
          <div className="flex-1 min-w-0">
            <p className="text-[14px]">{e.text}</p>
            <p className="text-[12px] text-ink-3">{LOG_LABEL[e.kind]} · {ago(e.at)}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The full conversation with Pin, on the page instead of the island. */
function PinChat() {
  const pin = usePin();
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [pin.messages, pin.thinking]);
  useEffect(() => input.current?.focus(), []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    pin.send(draft, { inPlace: true });
    setDraft("");
  };
  return (
    <Card className="flex flex-col h-[min(640px,calc(100dvh-300px))] fade-in">
      <div ref={list} className="flex-1 overflow-y-auto p-5 space-y-3">
        {pin.messages.length === 0 && (
          <div className="text-center pt-12">
            <Bot className="h-6 w-6 mx-auto text-ink-3" />
            <p className="text-[14px] text-ink-2 mt-3">Ask about the device, an organization, or tell Pin what to automate.</p>
            <div className="flex flex-wrap justify-center gap-2 mt-4">
              {["How is my server?", "Which agents are idle?", "If a VM uses more than 80% CPU for 5 minutes, notify me", "Create a company called Lumen"].map((s) => (
                <button key={s} onClick={() => pin.send(s, { inPlace: true })} className="text-[12px] px-3 py-1.5 rounded-full border border-line bg-surface-2 hover:bg-surface-3 text-ink-2">{s}</button>
              ))}
            </div>
          </div>
        )}
        {pin.messages.map((m) => (
          <div key={m.id} className={cn("fade-in flex", m.from === "you" ? "justify-end" : "justify-start gap-2.5")}>
            {m.from === "pin" && <span className="mt-0.5"><PinOrb size={22} /></span>}
            <div className={cn("max-w-[78%] text-[14px] leading-relaxed", m.from === "you" ? "bg-surface-3 rounded-2xl rounded-br-md px-3.5 py-2" : "")}>
              {m.text}
              {m.card && <PinCardView card={m.card} done={m.done} onDone={() => pin.markDone(m.id)} />}
            </div>
          </div>
        ))}
        {pin.thinking && <div className="text-[14px] shimmer-text">Pin is thinking…</div>}
      </div>
      <form onSubmit={submit} className="p-3 border-t border-line">
        <div className="flex items-center gap-2 rounded-full bg-surface-2 border border-line pl-4 pr-1.5 h-11 focus-within:border-line-strong">
          <input ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message Pin" aria-label="Message Pin" className="flex-1 bg-transparent outline-none text-[14px] placeholder:text-ink-3 min-w-0" />
          <button type="submit" disabled={!draft.trim()} className="h-8 w-8 rounded-full bg-primary text-primary-ink flex items-center justify-center disabled:opacity-30" aria-label="Send"><ArrowUp className="h-4 w-4" /></button>
        </div>
      </form>
    </Card>
  );
}

/** SOUL.md and MEMORY.md, editable side by side with a preview. */
function PinFiles() {
  const engine = useEngine();
  const [which, setWhich] = useState<"soul" | "memory">("soul");
  const saved = engine.pin[which];
  const [text, setText] = useState(saved);
  const [preview, setPreview] = useState(false);
  useEffect(() => setText(engine.pin[which]), [which]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = text !== saved;
  const file = which === "soul" ? "SOUL.md" : "MEMORY.md";
  return (
    <div className="grid lg:grid-cols-[240px_1fr] gap-5 fade-in">
      <div className="space-y-2">
        {([["soul", "SOUL.md", "Who Pin is: its character, its rules, what it cares about."], ["memory", "MEMORY.md", "What Pin knows about you and this device. It reads this before every conversation."]] as const).map(([k, f, body]) => (
          <button key={k} onClick={() => { if (!dirty || confirm("Discard unsaved changes?")) setWhich(k); }} aria-pressed={which === k} className={cn("w-full text-left rounded-xl border p-3.5 transition", which === k ? "border-accent/50 bg-accent-soft" : "border-line hover:border-line-strong")}>
            <div className="font-mono text-[13px] flex items-center gap-2"><FileText className="h-4 w-4 text-ink-3" />{f}</div>
            <p className="text-[12px] text-ink-3 mt-1">{body}</p>
          </button>
        ))}
        <p className="text-[12px] text-ink-3 px-1">These live on the device, not in an AI provider's account. Keep secrets in the Vault, not here.</p>
      </div>
      <Card className="flex flex-col min-h-[460px]">
        <div className="flex items-center gap-2 px-4 h-11 border-b border-line">
          <span className="font-mono text-[13px] flex-1">{file}{dirty && <span className="text-warning"> · unsaved</span>}</span>
          <Button size="sm" variant="ghost" onClick={() => setPreview((p) => !p)}><Eye className="h-3.5 w-3.5" />{preview ? "Edit" : "Preview"}</Button>
          <Button size="sm" variant="ghost" onClick={() => setText(which === "soul" ? DEFAULT_SOUL : DEFAULT_MEMORY)} title="Back to the starting text"><RotateCcw className="h-3.5 w-3.5" />Reset</Button>
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => engine.savePinFile(which, text)}><Save className="h-3.5 w-3.5" />Save</Button>
        </div>
        {preview ? (
          <div className="flex-1 p-5 overflow-y-auto text-[14px] leading-relaxed"><MarkdownPreview text={text} /></div>
        ) : (
          <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label={file} className="flex-1 w-full resize-none bg-transparent p-5 font-mono text-[13px] leading-relaxed outline-none" />
        )}
      </Card>
    </div>
  );
}

/** Just enough Markdown for Pin's files: headings, bullets and paragraphs, rendered as text (never as HTML). */
function MarkdownPreview({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = (key: number) => {
    if (bullets.length) out.push(<ul key={`u${key}`} className="list-disc pl-5 my-2 space-y-1">{bullets.map((b, i) => <li key={i}>{b || <span className="text-ink-3">(empty)</span>}</li>)}</ul>);
    bullets = [];
  };
  lines.forEach((l, i) => {
    const h = l.match(/^(#{1,3})\s+(.*)$/);
    const b = l.match(/^\s*[-*]\s?(.*)$/);
    if (b) return void bullets.push(b[1]);
    flush(i);
    if (h) out.push(h[1].length === 1 ? <h2 key={i} className="text-[20px] font-semibold mt-1 mb-3">{h[2]}</h2> : <h3 key={i} className="text-[15px] font-semibold mt-4 mb-1">{h[2]}</h3>);
    else if (l.trim()) out.push(<p key={i} className="my-2 text-ink-2">{l}</p>);
  });
  flush(lines.length);
  return <>{out}</>;
}

/** The system skills Pin has on this device, each gated by what Pin may do. */
function PinSkills({ onAsk, onGo }: { onAsk: (q: string) => void; onGo: (to: string) => void }) {
  const engine = useEngine();
  const device = engine.setup?.deviceName ?? "pve";
  const access = engine.setup?.pinAccess ?? { system: true, orgs: true, connectors: true, docs: true };
  const skills: { icon: ReactNode; name: string; body: string; on: boolean; needs: string; ask: string; to: string }[] = [
    { icon: <Boxes className="h-4 w-4" />, name: "Machines", body: "Status, power, snapshots and new machines, within each organization's resource group.", on: access.system, needs: "Manage this device", ask: "Which machines use the most memory?", to: `/${device}/machines` },
    { icon: <HardDrive className="h-4 w-4" />, name: "Storage", body: "Space on every drive, ISOs and templates, downloads.", on: access.system, needs: "Manage this device", ask: "How much space is left?", to: `/${device}/storage` },
    { icon: <Archive className="h-4 w-4" />, name: "Backups", body: "Back up now, check schedules, spot machines with no recent backup.", on: access.system, needs: "Manage this device", ask: "When did the last backup run?", to: `/${device}/backups` },
    { icon: <Network className="h-4 w-4" />, name: "Network", body: "Bridges, addresses and which machine is on which network.", on: access.system, needs: "Manage this device", ask: "Which machines are on which bridge?", to: `/${device}/network` },
    { icon: <Workflow className="h-4 w-4" />, name: "Automations", body: "Turns plain words into rules a strict validator checks before they run.", on: access.system, needs: "Manage this device", ask: "If a container uses more than 50% of its memory, shut it down", to: `/${device}/automations` },
    { icon: <Building2 className="h-4 w-4" />, name: "Organizations", body: "Creates organizations, sizes their resource groups, checks on their agents.", on: access.orgs, needs: "Manage organizations", ask: "Which agents are idle?", to: `/${device}/home` },
    { icon: <Cable className="h-4 w-4" />, name: "Connectors", body: "Uses the connectors you've shared with Pin, never anyone else's.", on: access.connectors, needs: "Use connectors", ask: "Which connectors can you use?", to: "?settings=connectors" },
    { icon: <BookOpen className="h-4 w-4" />, name: "Proxmox docs", body: "Looks things up in the Proxmox VE documentation when it answers.", on: access.docs, needs: "Read the Proxmox docs", ask: "How do I add a serial console to a VM?", to: "" },
  ];
  return (
    <div className="grid sm:grid-cols-2 gap-3 fade-in">
      {skills.map((s) => (
        <Card key={s.name} className={cn("p-4", !s.on && "opacity-60")}>
          <div className="flex items-center gap-3">
            <span className="h-9 w-9 rounded-lg bg-surface-2 flex items-center justify-center text-ink-2">{s.icon}</span>
            <div className="flex-1 min-w-0"><div className="font-medium text-[14px]">{s.name}</div><div className="text-[12px] text-ink-3">{s.on ? "On" : `Off · needs "${s.needs}"`}</div></div>
          </div>
          <p className="text-[13px] text-ink-2 mt-3">{s.body}</p>
          <div className="flex gap-2 mt-3">
            <Button size="sm" variant="ghost" disabled={!s.on} onClick={() => onAsk(s.ask)}><Sparkles className="h-3.5 w-3.5" />Try it</Button>
            {s.to && <Button size="sm" variant="ghost" onClick={() => onGo(s.to)}>Open</Button>}
          </div>
        </Card>
      ))}
    </div>
  );
}
