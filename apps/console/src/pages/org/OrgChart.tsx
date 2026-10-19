import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Maximize, Minus, Plus, Search } from "lucide-react";
import { useEngine } from "../../data/store.tsx";
import type { Agent, Org } from "../../data/types.ts";
import { cn } from "../../lib/storage.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Avatar, Input, PageFrame, PageHeader, Status, type StatusKind, Select } from "../../ui/primitives.tsx";
import { useOrg } from "./OrgPages.tsx";

const W = 216; // node width
const H = 84; // node height
const GX = 28; // horizontal gap
const GY = 72; // vertical gap
const YOU = "__you";

const STATUS: Record<Agent["status"], [StatusKind, string]> = { working: ["working", "Working"], idle: ["idle", "Idle"], paused: ["paused", "Paused"], error: ["critical", "Error"] };

interface Placed { id: string; x: number; y: number; agent: Agent | null; children: string[] }

/** Lays the tree out top-down: each subtree is as wide as its children, parents are centered above them. */
function layout(org: Org, collapsed: Set<string>): Map<string, Placed> {
  const kids = (id: string) => org.agents.filter((a) => (a.reportsTo ?? YOU) === id && a.id !== id).map((a) => a.id);
  const out = new Map<string, Placed>();
  const width = (id: string): number => {
    const c = collapsed.has(id) ? [] : kids(id);
    return c.length ? Math.max(W, c.reduce((s, k) => s + width(k), 0) + GX * (c.length - 1)) : W;
  };
  const place = (id: string, left: number, depth: number) => {
    const c = collapsed.has(id) ? [] : kids(id);
    const wd = width(id);
    out.set(id, { id, x: left + wd / 2 - W / 2, y: depth * (H + GY), agent: org.agents.find((a) => a.id === id) ?? null, children: kids(id) });
    let cursor = left;
    for (const k of c) {
      place(k, cursor, depth + 1);
      cursor += width(k) + GX;
    }
  };
  place(YOU, 0, 0);
  return out;
}

export function OrgChart() {
  const org = useOrg();
  const { setReportsTo } = useEngine();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; over: string | null } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pan = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const press = useRef<{ id: string; sx: number; sy: number; moved: boolean } | null>(null);

  const nodes = useMemo(() => (org ? layout(org, collapsed) : new Map<string, Placed>()), [org, collapsed]);
  const bounds = useMemo(() => {
    let maxX = W, maxY = H;
    for (const n of nodes.values()) {
      maxX = Math.max(maxX, n.x + W);
      maxY = Math.max(maxY, n.y + H);
    }
    return { w: maxX, h: maxY };
  }, [nodes]);

  const fit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const k = Math.min(1.2, Math.max(0.35, Math.min((el.clientWidth - 48) / bounds.w, (el.clientHeight - 48) / bounds.h)));
    setView({ k, x: (el.clientWidth - bounds.w * k) / 2, y: Math.max(24, (el.clientHeight - bounds.h * k) / 2) });
  }, [bounds]);
  useLayoutEffect(() => fit(), [fit]);

  // Wheel zooms around the cursor. Registered by hand so it can prevent the page from scrolling.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      setView((v) => {
        const k = Math.min(2, Math.max(0.3, v.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
        return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  if (!org) return null;

  const isDescendant = (id: string, of: string): boolean => {
    for (let cur: string | null | undefined = id, g = 0; cur && g < 100; g++) {
      if (cur === of) return true;
      cur = org.agents.find((a) => a.id === cur)?.reportsTo;
    }
    return false;
  };
  const validTarget = (dragged: string, target: string | null) => !!target && target !== dragged && !(target !== YOU && isDescendant(target, dragged)) && (org.agents.find((a) => a.id === dragged)?.reportsTo ?? YOU) !== target;
  const toCanvas = (cx: number, cy: number) => {
    const r = box.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  };
  const nodeAt = (cx: number, cy: number) => (document.elementsFromPoint(cx, cy).find((el) => (el as HTMLElement).dataset?.node) as HTMLElement | undefined)?.dataset.node ?? null;

  const onBgDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-node],button,input")) return;
    pan.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (pan.current) {
      const p = pan.current;
      setView((v) => ({ ...v, x: p.ox + e.clientX - p.sx, y: p.oy + e.clientY - p.sy }));
      return;
    }
    const pr = press.current;
    if (!pr) return;
    if (!pr.moved && Math.hypot(e.clientX - pr.sx, e.clientY - pr.sy) > 6) pr.moved = true;
    if (pr.moved) {
      const c = toCanvas(e.clientX, e.clientY);
      const over = nodeAt(e.clientX, e.clientY);
      setDrag({ id: pr.id, x: c.x, y: c.y, over: over && over !== pr.id ? over : null });
    }
  };
  const onUp = (e: React.PointerEvent) => {
    pan.current = null;
    const pr = press.current;
    press.current = null;
    if (!pr) return;
    if (!pr.moved) {
      setOpen(pr.id);
      return;
    }
    const target = nodeAt(e.clientX, e.clientY);
    setDrag(null);
    if (target && validTarget(pr.id, target)) {
      const r = setReportsTo(org.slug, pr.id, target === YOU ? null : target);
      const a = org.agents.find((x) => x.id === pr.id);
      const m = org.agents.find((x) => x.id === target);
      setToast(r.ok ? `${a?.name} now reports to ${m?.name ?? "you"}` : r.error ?? "Couldn't move");
      setTimeout(() => setToast(null), 2600);
    }
  };

  const needle = q.trim().toLowerCase();
  const match = (a: Agent | null) => !needle || (a && (a.name.toLowerCase().includes(needle) || a.role.toLowerCase().includes(needle)));
  const edges = [...nodes.values()].flatMap((n) => (collapsed.has(n.id) ? [] : n.children.map((c) => [n, nodes.get(c)!] as const))).filter(([, c]) => c);
  const selected = org.agents.find((a) => a.id === open);

  return (
    <PageFrame width="6xl">
      <PageHeader title="Org chart" subtitle="Drag an agent onto someone to change who they report to. Scroll to zoom, drag the background to move around." />
      <div className="relative rounded-xl border border-line bg-surface overflow-hidden h-[min(640px,calc(100dvh-240px))] min-h-[380px]">
        <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
          <div className="relative">
            <Search className="h-3.5 w-3.5 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an agent" className="h-9 w-48 pl-8 text-compact" aria-label="Find an agent" />
          </div>
        </div>
        <div className="absolute right-3 top-3 z-10 flex rounded-lg border border-line bg-surface-2 overflow-hidden">
          <button onClick={() => setView((v) => ({ ...v, k: Math.min(2, v.k * 1.2) }))} className="h-9 w-9 flex items-center justify-center hover:bg-surface-3" aria-label="Zoom in"><Plus className="h-4 w-4" /></button>
          <button onClick={() => setView((v) => ({ ...v, k: Math.max(0.3, v.k / 1.2) }))} className="h-9 w-9 flex items-center justify-center hover:bg-surface-3 border-x border-line" aria-label="Zoom out"><Minus className="h-4 w-4" /></button>
          <button onClick={fit} className="h-9 w-9 flex items-center justify-center hover:bg-surface-3" aria-label="Fit to screen"><Maximize className="h-4 w-4" /></button>
        </div>
        <div ref={box} className={cn("absolute inset-0 touch-none select-none", pan.current ? "cursor-grabbing" : "cursor-grab")} onPointerDown={onBgDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { pan.current = null; press.current = null; setDrag(null); }}
          style={{ backgroundImage: "radial-gradient(var(--line-strong) 1px, transparent 1px)", backgroundSize: `${22 * view.k}px ${22 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}>
          <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, width: bounds.w, height: bounds.h }}>
            <svg className="absolute inset-0 overflow-visible pointer-events-none" width={bounds.w} height={bounds.h} aria-hidden>
              {edges.map(([p, c]) => {
                const x1 = p.x + W / 2, y1 = p.y + (p.id === YOU ? 44 : H), x2 = c.x + W / 2, y2 = c.y, my = (y1 + y2) / 2;
                return <path key={`${p.id}-${c.id}`} d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`} fill="none" stroke="var(--line-strong)" strokeWidth={1.5} />;
              })}
            </svg>
            {[...nodes.values()].map((n) => {
              const target = drag && drag.over === n.id;
              const ok = drag ? validTarget(drag.id, n.id) : false;
              if (n.id === YOU) {
                return (
                  <div key={n.id} data-node={YOU} className={cn("absolute rounded-full border bg-surface-2 flex items-center justify-center text-compact font-medium transition", target && ok ? "border-accent ring-2 ring-accent/40" : "border-line-strong")} style={{ left: n.x + W / 2 - 60, top: n.y, width: 120, height: 44 }}>
                    You
                  </div>
                );
              }
              const a = n.agent!;
              const [kind, label] = STATUS[a.status];
              const hasKids = n.children.length > 0;
              return (
                <div key={n.id} className="absolute" style={{ left: n.x, top: n.y, width: W, height: H }}>
                  <button
                    data-node={a.id}
                    onPointerDown={(e) => { e.stopPropagation(); press.current = { id: a.id, sx: e.clientX, sy: e.clientY, moved: false }; box.current?.setPointerCapture(e.pointerId); }}
                    onKeyDown={(e) => e.key === "Enter" && setOpen(a.id)}
                    className={cn(
                      "w-full h-full rounded-xl border bg-surface-2 px-3 text-left flex items-center gap-2.5 transition-[border-color,box-shadow,opacity] cursor-pointer",
                      drag?.id === a.id ? "opacity-40" : match(a) ? "opacity-100" : "opacity-35",
                      target ? (ok ? "border-accent ring-2 ring-accent/40" : "border-critical/60") : a.status === "working" ? "border-good/40" : "border-line-strong hover:border-ink-3",
                    )}
                    aria-label={`${a.name}, ${a.role}, ${label}. Press Enter for details.`}
                  >
                    <Avatar name={a.name} hue={org.hue + 40} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium truncate">{a.name}</span>
                      <span className="block text-xs text-ink-3 truncate">{a.role} · {a.adapter}</span>
                      <Status kind={kind} label={label} className="text-xs" />
                    </span>
                  </button>
                  {hasKids && (
                    <button onClick={() => setCollapsed((s) => { const next = new Set(s); if (next.has(a.id)) next.delete(a.id); else next.add(a.id); return next; })} className="absolute left-1/2 -translate-x-1/2 -bottom-3 h-6 min-w-6 px-1.5 rounded-full border border-line-strong bg-surface text-micro text-ink-2 flex items-center gap-0.5 hover:text-ink" aria-label={collapsed.has(a.id) ? `Show ${n.children.length} reports` : `Hide reports`} aria-expanded={!collapsed.has(a.id)}>
                      {collapsed.has(a.id) ? <><ChevronRight className="h-3 w-3" />{n.children.length}</> : <ChevronDown className="h-3 w-3" />}
                    </button>
                  )}
                </div>
              );
            })}
            {drag && (() => {
              const a = org.agents.find((x) => x.id === drag.id)!;
              return (
                <div className="absolute pointer-events-none rounded-xl border border-accent bg-surface-3 px-3 flex items-center gap-2 shadow-2xl" style={{ left: drag.x - W / 2, top: drag.y - H / 2, width: W, height: 56 }}>
                  <Avatar name={a.name} hue={org.hue + 40} size={28} />
                  <span className="text-compact font-medium">{a.name}</span>
                </div>
              );
            })()}
          </div>
        </div>
        {toast && <div role="status" className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-surface-3 border border-line-strong px-4 h-9 flex items-center text-compact shadow-xl fade-in">{toast}</div>}
      </div>
      {selected && (
        <Modal title={selected.name} subtitle={`${selected.role} in ${org.name}`} icon={<Avatar name={selected.name} hue={org.hue + 40} size={40} />} onClose={() => setOpen(null)}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm items-center">
            <dt className="text-ink-3">Status</dt><dd><Status kind={STATUS[selected.status][0]} label={STATUS[selected.status][1]} /></dd>
            <dt className="text-ink-3">Working on</dt><dd>{selected.task ?? "Nothing right now"}</dd>
            <dt className="text-ink-3">Harness</dt><dd>{selected.adapter} · {selected.engine === "native" ? "native" : "container sessions"}</dd>
            <dt className="text-ink-3">Reports to</dt>
            <dd>
              <Select
                value={selected.reportsTo ?? ""}
                onChange={(e) => {
                  const r = setReportsTo(org.slug, selected.id, e.target.value || null);
                  if (!r.ok) setToast(r.error ?? "Couldn't move");
                }}
                className="h-9 rounded-lg bg-surface-2 border border-line px-2 text-sm"
                aria-label={`${selected.name} reports to`}
              >
                <option value="">You</option>
                {org.agents.filter((x) => x.id !== selected.id && !isDescendant(x.id, selected.id)).map((x) => <option key={x.id} value={x.id}>{x.name} · {x.role}</option>)}
              </Select>
            </dd>
            <dt className="text-ink-3">Direct reports</dt><dd>{org.agents.filter((x) => x.reportsTo === selected.id).map((x) => x.name).join(", ") || "None"}</dd>
          </dl>
        </Modal>
      )}
    </PageFrame>
  );
}
