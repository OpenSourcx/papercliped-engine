import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, CheckCheck, Circle, CircleX, ClipboardList, FileText, FolderOpen, FolderTree, GitPullRequest, ListChecks, ListTree, Loader2, MessageCircle, MessagesSquare, MoreHorizontal, Package, PanelLeft, PanelRight, RefreshCw, Share, Sparkles, SquareTerminal } from "lucide-react";
import type { Agent, CompanyArtifact } from "@papercliped-engine/engine-client";
import { useAgentsCanRun } from "../containers/Banner.tsx";
import { chatBlock, useSendChat } from "../../data/engine/chat.ts";
import { useChats, useChatsOf, useChatWrites } from "../../data/engine/more.ts";
import { agentStatusOf } from "../../data/engine/labels.tsx";
import { pinRt } from "../../data/engine/pinRuntimeApi.ts";
import { engine as engineApi, errorText, useAgentContainers, useAgentsOf, useComments, useConnectors, useRuns } from "../../data/engine/queries.ts";
import { useEngine } from "../../data/store.tsx";
import { cn, readJson, writeJson } from "../../lib/storage.ts";
import { settingsHref } from "../../modals/useModals.ts";
import type { ConversationItem } from "../../pin/ConversationList.tsx";
import { PERMISSION_INFO } from "../../pin/PermissionPicker.tsx";
import { usePin } from "../../pin/PinContext.tsx";
import { PinOrb } from "../../pin/PinOrb.tsx";
import { PinThread } from "../../pin/PinThread.tsx";
import { ThreadProvider, type ThreadApi } from "../../pin/ThreadContext.tsx";
import type { ThreadMessage } from "../../pin/useThread.ts";
import { ConfirmModal } from "../../ui/Confirm.tsx";
import { Menu, Notice, ResizeHandle, Select, type MenuEntry } from "../../ui/primitives.tsx";
import { Preview } from "../org/live/LiveArtifacts.tsx";
import { useNames } from "../org/live/names.ts";
import { ChangesBody, PullRequestList, useGithub } from "./Changes.tsx";
import { FilesPanel } from "./FilesPanel.tsx";
import { FileEditor } from "./MachineFiles.tsx";
import { copyText, TileView } from "./TileView.tsx";
import { tilesOf, type Tile } from "./tiles.ts";
import { SEEN, SINCE } from "./unread.ts";
import { MachineTerminal } from "./workspace/MachineTerminal.tsx";
import { Cards, type CardsModel } from "./workspace/Cards.tsx";
import { Palette, type Command } from "./workspace/Palette.tsx";
import { EditorGroup, type TabHead } from "./workspace/EditorGroup.tsx";
import { Explorer } from "./workspace/Explorer.tsx";
import { useLayout, type TileKind } from "./workspace/layout.ts";
import { Sidebar, type SideGroup, type SideRow } from "./workspace/Sidebar.tsx";
import { TileStack, type TileSpec } from "./workspace/Tiles.tsx";

/**
 * PinView: the workspace for working with Pin and your agents, laid out like a desktop chat app.
 *
 *   sidebar | conversation (toolbar: cards, plan, terminal, files, more, share) | cards | tiles
 *
 * The sidebar lists places and conversations (Pinned, one group per organization, Recents). The cards say what the
 * conversation runs on and with: Environment, Context, Connectors, Changes, Background tasks. The tiles stack beside them:
 * Plan (the conversation's tasks), Files (tabs with a machine's tree), Terminal, Artifacts, Pull requests; each one
 * resizes, expands and closes. Files and plans Pin's steps touch open there by themselves. The toolbar icons show what is
 * open and toggle it. Ctrl/Cmd+P searches everything; Ctrl/Cmd+B hides the sidebar, Ctrl/Cmd+. the cards. On a phone each
 * part is a screen of its own.
 */

type View = { kind: "pin" } | { kind: "agent"; companyId: string; agentId: string };
type ETab = { id: string; preview: boolean } & ({ kind: "tool"; toolId: string } | { kind: "file"; vmid: number; path: string; edit?: boolean } | { kind: "artifact"; artifact: CompanyArtifact });
const agentKey = (companyId: string, agentId: string) => `agent:${companyId}:${agentId}`;
const PINNED = "epc.pinview.pinned";
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const wide = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1024px)").matches;
/** A rough count of tokens: about four characters each, which is what most models' tokenizers average on English and code. */
const tokensOf = (ms: ThreadMessage[]) => Math.round(ms.reduce((n, m) => n + m.text.length + (m.tool ? JSON.stringify(m.tool.args ?? {}).length + (m.tool.result?.length ?? 0) : 0), 0) / 4);

/** An icon in the conversation's toolbar that shows whether what it opens is open. */
function ToolIcon({ label, on, onClick, children, badge }: { label: string; on?: boolean; onClick: () => void; children: ReactNode; badge?: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={on} onClick={onClick}
      className={cn("transition-control relative h-8 w-8 rounded-md flex items-center justify-center", on ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink hover:bg-surface-2")}>
      {children}{badge}
    </button>
  );
}

const TASK_ICON = { done: <Check className="h-3.5 w-3.5 text-ink-3" />, failed: <CircleX className="h-3.5 w-3.5 text-critical" />, running: <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />, waiting: <Circle className="h-3.5 w-3.5 text-ink-3" /> } as const;

export function PinView() {
  const { data, setup, live } = useEngine();
  const pin = usePin();
  const qc = useQueryClient();
  const nav = useNavigate();
  const connectors = useConnectors();
  const github = useGithub();
  const device = setup?.deviceName ?? "pve";
  const machines = data.guests ?? [];
  const [params, setParams] = useSearchParams();
  const { layout, set, toggleTile, showTile, closeTile } = useLayout();
  const [tabs, setTabs] = useState<ETab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [closing, setClosing] = useState<string[] | null>(null);
  const [closedTools, setClosedTools] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<TileKind | null>(null);
  const [palette, setPalette] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [filesOrg, setFilesOrg] = useState<string | null>(null);
  const [explorerVmid, setExplorerVmid] = useState<number | null>(null);
  const [termTarget, setTermTarget] = useState("host");
  const [sheet, setSheet] = useState<null | "cards" | "tiles">(null);
  const [shared, setShared] = useState(false);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set(readJson<string[]>(PINNED, [])));
  const [since] = useState<number>(() => { const v = readJson<number | null>(SINCE, null); if (v === null) { const n = Date.now(); writeJson(SINCE, n); return n; } return v; });
  const [seenAt, setSeenAt] = useState<Record<string, number>>(() => readJson<Record<string, number>>(SEEN, {}));
  const orgs = data.orgs.flatMap((o) => (o.engine ? [{ name: o.name, slug: o.slug, companyId: o.engine.companyId }] : []));
  const ids = orgs.map((o) => o.companyId);
  const agents = useAgentsOf(ids);
  const chats = useChatsOf(ids);
  const plans = useQuery({ queryKey: ["pin", "plans"], queryFn: pinRt.plans, enabled: live, refetchInterval: 15_000, retry: false });

  // ---- Which conversation is open, and the history to go back and forth through

  const view: View = useMemo(() => {
    const [kind, companyId, agentId] = (params.get("c") ?? "").split(":");
    return kind === "agent" && companyId && agentId ? { kind: "agent", companyId, agentId } : { kind: "pin" };
  }, [params]);
  const history = useRef<{ list: string[]; at: number }>({ list: [], at: -1 });
  const [, bump] = useState(0);
  const open = useCallback((v: View, fromHistory = false) => {
    setParams((p) => { const n = new URLSearchParams(p); n.delete("chat"); if (v.kind === "pin") n.delete("c"); else n.set("c", `agent:${v.companyId}:${v.agentId}`); n.set("t", "1"); return n; }, { replace: true });
    if (!fromHistory) {
      const key = v.kind === "pin" ? "pin" : agentKey(v.companyId, v.agentId);
      const h = history.current;
      if (h.list[h.at] !== key) { h.list = [...h.list.slice(0, h.at + 1), key]; h.at = h.list.length - 1; bump((x) => x + 1); }
    }
  }, [setParams]);
  const goHistory = (d: -1 | 1) => {
    const h = history.current;
    const key = h.list[h.at + d];
    if (!key) return;
    h.at += d;
    bump((x) => x + 1);
    if (key === "pin") open({ kind: "pin" }, true);
    else { const [, c, a] = key.split(":"); open({ kind: "agent", companyId: c!, agentId: a! }, true); }
  };
  const toList = () => setParams((p) => { const n = new URLSearchParams(p); n.delete("t"); return n; }, { replace: true });
  const onPhoneThread = !!params.get("t");
  const linked = params.get("chat");
  useEffect(() => {
    if (linked && linked !== pin.chatId) void pin.openChat(linked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked]);
  const newPinChat = () => { pin.newChat(); open({ kind: "pin" }); };

  // ---- Conversations: Pinned, one group per organization, Recents (Pin's chats); unread and what is working

  const agentName = (companyId: string, agentId: string) => agents[ids.indexOf(companyId)]?.data?.find((a) => a.id === agentId)?.name ?? "Agent";
  const allAgents = orgs.flatMap((o, i) => (agents[i]?.data ?? []).filter((a) => a.status !== "terminated").map((a) => ({ companyId: o.companyId, org: o.name, agentId: a.id, name: a.name })));
  const activeKey = view.kind === "agent" ? agentKey(view.companyId, view.agentId) : pin.chatId ? `pin:${pin.chatId}` : null;
  const pinWaiting = pin.messages.some((m) => m.tool && (m.tool.status === "approval" || m.tool.status === "proposed") && !m.tool.resolved);
  const rows = useMemo(() => {
    const unread = (key: string, at: number) => key !== activeKey && at > (seenAt[key] ?? since);
    const pinRows: SideRow[] = pin.chats.map((c) => {
      const key = `pin:${c.id}`;
      const at = new Date(c.updatedAt).getTime();
      return { key, source: "pin", title: c.title, context: "Pin", updatedAt: at, unread: unread(key, at), status: key === activeKey ? (pin.streaming ? "working" : pinWaiting ? "waiting" : undefined) : undefined };
    });
    const byOrg = orgs.map((org, i) => ({ org, rows: (chats[i]?.data ?? []).flatMap((c): SideRow[] => {
      if (!c.conversationAgentId) return [];
      const key = agentKey(org.companyId, c.conversationAgentId);
      const at = new Date(c.updatedAt).getTime();
      return [{ key, source: "agent", title: agentName(org.companyId, c.conversationAgentId), context: org.name, updatedAt: at, unread: unread(key, at), status: c.conversationState === "active" ? "working" : undefined }];
    }).sort((a, b) => b.updatedAt - a.updatedAt) }));
    return { pinRows: pinRows.sort((a, b) => b.updatedAt - a.updatedAt), byOrg };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin.chats, pin.streaming, pinWaiting, activeKey, seenAt, since, chats.map((q) => q.dataUpdatedAt).join(), agents.map((q) => q.dataUpdatedAt).join(), ids.join()]);
  const everything = [...rows.pinRows, ...rows.byOrg.flatMap((o) => o.rows)];
  const activeAt = everything.find((c) => c.key === activeKey)?.updatedAt ?? 0;
  useEffect(() => {
    if (!activeKey) return;
    setSeenAt((prev) => {
      if (prev[activeKey] !== undefined && prev[activeKey] >= activeAt) return prev;
      const next = { ...prev, [activeKey]: Math.max(Date.now(), activeAt) };
      writeJson(SEEN, next);
      return next;
    });
  }, [activeKey, activeAt]);
  const markRead = (xs: ConversationItem[]) => { const n = Date.now(); setSeenAt((p) => { const m = { ...p, ...Object.fromEntries(xs.map((c) => [c.key, Math.max(n, c.updatedAt)])) }; writeJson(SEEN, m); return m; }); };
  const unreadCount = everything.filter((c) => c.unread).length;
  const togglePin = (key: string) => setPinned((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); writeJson(PINNED, [...n]); return n; });
  const pick = (r: ConversationItem) => {
    if (r.source === "pin") { void pin.openChat(r.key.slice(4)); open({ kind: "pin" }); }
    else { const [, companyId, agentId] = r.key.split(":"); open({ kind: "agent", companyId: companyId!, agentId: agentId! }); }
  };
  const linkFor = (r: ConversationItem) => `${window.location.origin}/${device}/view?${r.source === "pin" ? `chat=${encodeURIComponent(r.key.slice(4))}` : `c=${encodeURIComponent(r.key)}`}`;
  const groups: SideGroup[] = [
    ...(pinned.size ? [{ id: "pinned", label: "Pinned", rows: everything.filter((r) => pinned.has(r.key)), actions: [{ label: "Mark as read", onSelect: () => markRead(everything.filter((r) => pinned.has(r.key))) }] }] : []),
    ...rows.byOrg.map((o) => {
      const theirs = allAgents.filter((a) => a.companyId === o.org.companyId);
      return {
        id: o.org.companyId, label: o.org.name, rows: o.rows.filter((r) => !pinned.has(r.key)), empty: theirs.length ? "No chats yet." : "No agents yet.",
        actions: [...(theirs.length ? [{ kind: "heading" as const, label: "New chat with" }, ...theirs.map((a): MenuEntry => ({ label: a.name, onSelect: () => open({ kind: "agent", companyId: a.companyId, agentId: a.agentId }) }))] : []), { kind: "separator" as const }, { label: "Mark as read", onSelect: () => markRead(o.rows), disabled: !o.rows.some((r) => r.unread) }],
      };
    }),
    { id: "recents", label: "Recents", rows: rows.pinRows.filter((r) => !pinned.has(r.key)), limit: 12, empty: live ? "Your chats with Pin show here." : "Chats are kept on a device; the demo doesn't save them.", actions: [{ label: "New chat with Pin", onSelect: newPinChat }, { label: "Mark as read", onSelect: () => markRead(rows.pinRows), disabled: !rows.pinRows.some((r) => r.unread) }] },
  ];
  const rowMenu = (r: SideRow): MenuEntry[] => [
    { label: pinned.has(r.key) ? "Unpin" : "Pin", onSelect: () => togglePin(r.key) },
    ...(r.source === "pin" ? [{ label: "Rename", onSelect: () => setRenaming(r.key) }] : []),
    { label: "Copy link", onSelect: () => copyText(linkFor(r)) },
    ...(r.unread ? [{ label: "Mark as read", onSelect: () => markRead([r]) }] : []),
    ...(r.source === "pin" ? [{ kind: "separator" as const }, { label: "Delete", danger: true, onSelect: () => setDeleting(r) }] : []),
  ];
  const [deleting, setDeleting] = useState<SideRow | null>(null);

  const current = view.kind === "agent" ? allAgents.find((a) => a.companyId === view.companyId && a.agentId === view.agentId) : null;
  const currentAgent = current ? agents[ids.indexOf(current.companyId)]?.data?.find((a) => a.id === current.agentId) ?? null : null;
  const permission = PERMISSION_INFO.find((p) => p.id === pin.settings?.permission)?.label;
  const title = view.kind === "pin" ? (pin.chats.find((c) => c.id === pin.chatId)?.title ?? "New chat") : current?.name ?? "Agent";
  const messages = view.kind === "pin" ? pin.messages : [];

  // ---- Files tile: tabs for machine files, Pin's steps (previews) and artifacts

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const openTab = useCallback((t: ETab, focus = true) => {
    setTabs((list) => {
      const at = list.findIndex((x) => x.id === t.id);
      if (at >= 0) return list.map((x, i) => (i === at ? { ...x, ...t, preview: x.preview && t.preview } : x));
      const pre = t.preview ? list.findIndex((x) => x.preview && !dirtyRef.current.has(x.id)) : -1;
      if (pre >= 0) return list.map((x, i) => (i === pre ? t : x));
      return [...list, t];
    });
    if (focus) setActiveTab(t.id);
    showTile("files");
  }, [showTile]);
  const closeTabs = (list: string[], force = false) => {
    if (!force && list.some((i) => dirty.has(i))) { setClosing(list); return; }
    const toolIds = tabs.filter((t) => list.includes(t.id) && t.kind === "tool").map((t) => (t as { toolId: string }).toolId);
    if (toolIds.length) setClosedTools((c) => new Set([...c, ...toolIds]));
    setTabs((all) => {
      const left = all.filter((t) => !list.includes(t.id));
      if (activeTab && list.includes(activeTab)) { const i = all.findIndex((t) => t.id === activeTab); setActiveTab(left[Math.min(i, left.length - 1)]?.id ?? null); }
      return left;
    });
  };
  const keep = (id: string) => setTabs((all) => all.map((t) => (t.id === id ? { ...t, preview: false } : t)));
  const openFile = (vmid: number, path: string, edit = false) => openTab({ id: `file:${vmid}:${path}`, kind: "file", vmid, path, edit, preview: false });

  const tiles = useMemo(() => (view.kind === "pin" ? tilesOf(pin.messages, new Set()) : []), [view.kind, pin.messages]);
  const tileById = useMemo(() => new Map(tiles.map((t) => [t.id, t])), [tiles]);
  const seenTiles = useRef(new Set<string>());
  useEffect(() => {
    const fresh = tiles.filter((t) => !seenTiles.current.has(t.id) && !closedTools.has(t.id));
    tiles.forEach((t) => seenTiles.current.add(t.id));
    if (!fresh.length || !wide()) return;
    if (fresh.some((t) => t.kind === "plan")) showTile("plan");
    const last = [...fresh].reverse().find((t) => t.kind !== "plan");
    if (last) openTab({ id: `tool:${last.id}`, kind: "tool", toolId: last.id, preview: true });
  }, [tiles, closedTools, openTab, showTile]);
  const openStep = (toolId: string) => { if (tileById.has(toolId) && tileById.get(toolId)!.kind !== "plan") openTab({ id: `tool:${toolId}`, kind: "tool", toolId, preview: false }); };

  const tabIcon = (t: ETab) => {
    const k = t.kind === "tool" ? tileById.get(t.toolId)?.kind : t.kind;
    return k === "command" ? <SquareTerminal className="h-3.5 w-3.5 text-ink-3" /> : k === "plan" ? <ClipboardList className="h-3.5 w-3.5 text-ink-3" /> : k === "artifact" ? <Package className="h-3.5 w-3.5 text-ink-3" /> : <FileText className="h-3.5 w-3.5 text-ink-3" />;
  };
  const heads: TabHead[] = tabs.map((t) => {
    if (t.kind === "tool") { const tile = tileById.get(t.toolId); return { id: t.id, title: tile?.title ?? "Step", icon: tabIcon(t), preview: t.preview, hint: tile?.kind === "file" ? tile.path : tile?.kind === "command" ? tile.command : tile?.title }; }
    if (t.kind === "file") return { id: t.id, title: base(t.path), icon: tabIcon(t), preview: t.preview, dirty: dirty.has(t.id), hint: `${machines.find((m) => m.vmid === t.vmid)?.name ?? t.vmid}: ${t.path}` };
    return { id: t.id, title: t.artifact.title, icon: tabIcon(t), preview: t.preview, hint: `${t.artifact.issue.identifier}: ${t.artifact.title}` };
  });
  const active = tabs.find((t) => t.id === activeTab) ?? tabs[tabs.length - 1] ?? null;
  const tabBody = (t: ETab | null): ReactNode => {
    if (!t) return <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6"><FileText className="h-6 w-6 text-ink-3" aria-hidden /><p className="text-compact text-ink-3 text-pretty">Open a file from the tree, or ask Pin to read one. Files and plans it touches open here.</p></div>;
    if (t.kind === "tool") {
      const tile = tileById.get(t.toolId);
      if (!tile) return <div className="p-6"><Notice tone="info">This step belongs to another conversation.</Notice></div>;
      return <TileView key={t.id} tab tile={tile} device={device} expanded={false} onExpand={() => undefined} onClose={() => closeTabs([t.id])} onEditLive={(vmid, path) => openFile(vmid, path, true)} />;
    }
    if (t.kind === "file") return <FileEditor key={t.id} tab vmid={t.vmid} path={t.path} startEditing={t.edit} machineName={machines.find((g) => g.vmid === t.vmid)?.name} expanded={false} onExpand={() => undefined} onClose={() => closeTabs([t.id])} onDirty={(d) => { setDirty((s) => { const n = new Set(s); if (d) n.add(t.id); else n.delete(t.id); return n; }); if (d) keep(t.id); }} />;
    const a = t.artifact;
    const dl = a.downloadPath ?? a.contentPath;
    return (
      <div className="h-full flex flex-col">
        <div className="h-9 shrink-0 flex items-center gap-3 pl-4 pr-2 border-b border-line text-xs text-ink-3">
          <span className="truncate flex-1">From <span className="font-mono">{a.issue.identifier}</span>: {a.issue.title}</span>
          {dl && engineApi.artifacts.pathUrl(dl) && <a href={engineApi.artifacts.pathUrl(dl) ?? undefined} download className="text-accent hover:underline">Download</a>}
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-4">{a.contentPath ? <Preview path={a.contentPath} contentType={a.contentType} mediaKind={a.mediaKind} title={a.title} /> : a.previewText ? <p className="text-sm text-ink-2 whitespace-pre-wrap break-words">{a.previewText}</p> : <Notice tone="info">There is no preview for this one.</Notice>}</div>
      </div>
    );
  };

  // ---- Plan tile: the conversation's tasks (a written plan's steps, or the steps Pin took)

  const planTile = [...tiles].reverse().find((t): t is Extract<Tile, { kind: "plan" }> => t.kind === "plan");
  const planId = planTile ? String((pin.messages.find((m) => m.tool?.id === planTile.id)?.tool?.args as { planId?: string } | undefined)?.planId ?? "") : "";
  const livePlan = plans.data?.plans.find((p) => p.id === planId);
  const tasks: { id: string; label: string; state: keyof typeof TASK_ICON; onOpen?: () => void }[] = livePlan
    ? livePlan.steps.map((st) => ({ id: st.id, label: st.label, state: st.state === "done" ? "done" : st.state === "failed" ? "failed" : st.state === "running" ? "running" : "waiting" }))
    : planTile ? planTile.steps.map((st, i) => ({ id: String(i), label: st.label, state: "waiting" }))
    : messages.filter((m) => m.tool).map((m) => ({ id: m.tool!.id, label: m.tool!.label ?? m.tool!.title ?? m.tool!.name.replace(/_/g, " "), state: m.tool!.status === "done" ? "done" : m.tool!.status === "failed" ? "failed" : m.tool!.status === "running" ? "running" : "waiting", onOpen: () => openStep(m.tool!.id) }));
  const running = messages.filter((m) => m.tool?.status === "running").map((m) => m.tool!);

  // ---- Tiles

  const tileSpecs: Record<TileKind, TileSpec> = {
    plan: {
      kind: "plan", label: "Plan", title: livePlan?.title ?? planTile?.title ?? "Plan",
      actions: livePlan || planTile ? <a href={`/${device}/pin?tab=plans`} className="text-xs text-accent hover:underline mr-1">Review</a> : undefined,
      body: (
        <div className="h-full overflow-y-auto px-4 py-3">
          <div className="text-micro font-semibold uppercase tracking-label text-ink-3 mb-2">Tasks</div>
          {tasks.length === 0 ? <p className="text-compact text-ink-3 text-pretty">When Pin writes a plan or works through steps, its tasks show here and tick off as they finish.</p> : (
            <ol className="space-y-1.5">
              {tasks.map((t) => (
                <li key={t.id}>
                  <button type="button" disabled={!t.onOpen} onClick={t.onOpen} className="w-full flex items-start gap-2.5 text-left text-compact rounded-md px-1 py-0.5 enabled:hover:bg-surface-2">
                    <span className="mt-0.5 shrink-0">{TASK_ICON[t.state]}</span>
                    <span className={cn("text-pretty", t.state === "done" && "line-through text-ink-3", t.state === "running" && "text-ink font-medium", t.state === "failed" && "text-critical")}>{t.label}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      ),
    },
    files: {
      kind: "files", label: "Files", title: active ? heads.find((h) => h.id === active.id)?.title ?? "Files" : "Files",
      actions: (
        <>
          <button type="button" aria-label={layout.fileTree ? "Hide the file tree" : "Show the file tree"} title={layout.fileTree ? "Hide the file tree" : "Show the file tree"} aria-pressed={layout.fileTree} onClick={() => set((l) => ({ fileTree: !l.fileTree }))} className={cn("transition-control h-7 w-7 rounded-md flex items-center justify-center hover:bg-surface-2", layout.fileTree ? "text-ink" : "text-ink-3")}><ListTree className="h-4 w-4" /></button>
          <Menu size="sm" label="Files options" icon={<MoreHorizontal className="h-4 w-4" />} items={[
            { kind: "check", label: "Show file tree", checked: layout.fileTree, onToggle: (v) => set({ fileTree: v }) },
            { kind: "separator" },
            { label: "Keep this tab open", onSelect: () => active && keep(active.id), disabled: !active?.preview },
            { label: "Close all tabs", onSelect: () => closeTabs(tabs.map((t) => t.id)), disabled: !tabs.length },
          ]} />
        </>
      ),
      body: (
        <div className="h-full flex min-h-0">
          {layout.fileTree && <div className="w-56 shrink-0 border-r border-line min-h-0"><Explorer machines={machines} vmid={explorerVmid} onVmid={setExplorerVmid} onOpenFile={(vmid, path) => openFile(vmid, path)} activePath={active?.kind === "file" && active.vmid === explorerVmid ? active.path : null} /></div>}
          <div className="flex-1 min-w-0 min-h-0">
            {tabs.length ? <EditorGroup tabs={heads} active={active?.id ?? null} onActivate={setActiveTab} onClose={(id) => closeTabs([id])} onKeep={keep} onCloseMany={closeTabs}>{tabBody(active)}</EditorGroup> : tabBody(null)}
          </div>
        </div>
      ),
    },
    terminal: {
      kind: "terminal", label: "Terminal", title: "Terminal",
      actions: (
        <div className="w-48 mr-1">
          <Select aria-label="Terminal on" size="sm" value={termTarget} onChange={(e) => setTermTarget(e.target.value)}>
            <option value="host">This device</option>
            {machines.filter((g) => g.status === "running" && !g.template).map((g) => <option key={g.vmid} value={String(g.vmid)}>{g.name} ({g.vmid})</option>)}
          </Select>
        </div>
      ),
      body: <MachineTerminal target={termTarget} />,
    },
    artifacts: {
      kind: "artifacts", label: "Artifacts", title: "Artifacts",
      body: <div className="h-full overflow-y-auto p-3"><FilesPanel orgs={orgs} companyId={filesOrg ?? (view.kind === "agent" ? view.companyId : orgs[0]?.companyId ?? null)} onOrg={setFilesOrg} onOpen={(a) => openTab({ id: `artifact:${a.id}`, kind: "artifact", artifact: a, preview: true })} /></div>,
    },
    prs: {
      kind: "prs", label: "Pull requests", title: "Pull requests",
      actions: github.status.data?.connected ? <button type="button" aria-label="Refresh" title="Refresh" onClick={() => void qc.invalidateQueries({ queryKey: ["github", "prs"] })} className="transition-control h-7 w-7 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2"><RefreshCw className="h-3.5 w-3.5" /></button> : undefined,
      body: <div className="h-full overflow-y-auto p-3 space-y-3">{github.status.data?.connected ? <PullRequestList prs={github.prs.data?.prs ?? []} /> : <ChangesBody onShowAll={() => undefined} editing={false} onEdited={() => undefined} />}</div>,
    },
  };
  const openTiles = layout.tiles.map((k) => tileSpecs[k]);

  // ---- Cards

  const touched = [...new Set(messages.flatMap((m) => (typeof m.tool?.args?.vmid === "number" ? [m.tool.args.vmid as number] : [])))];
  const prs = github.prs.data?.prs ?? [];
  const cards: CardsModel = {
    device, live, settingsTo: settingsHref("general"),
    machines: touched.map((v) => ({ vmid: v, name: machines.find((g) => g.vmid === v)?.name ?? `Machine ${v}`, onOpen: () => { setExplorerVmid(v); set({ fileTree: true }); showTile("files"); } })),
    repos: github.status.data?.connected ? github.status.data.repos : [],
    githubConnected: !!github.status.data?.connected,
    onConnectGithub: () => showTile("prs"),
    context: messages.length ? { used: tokensOf(messages), total: 200_000 } : null,
    connectors: (connectors.data?.connectors ?? []).map((c) => ({ id: c.id, label: c.label ?? c.id, state: !c.configured ? "off" : (c as { ok?: boolean }).ok === false ? "attention" : "ok", to: settingsHref("connectors") })),
    connectorsTo: settingsHref("connectors"),
    changes: github.status.data?.connected ? { open: prs.filter((p) => p.state === "open").length, failing: prs.filter((p) => p.state === "open" && p.checks === "failure").length, merged: prs.filter((p) => p.state === "merged").length } : null,
    onOpenPrs: () => showTile("prs"),
    tasks: running.map((t) => ({ id: t.id, label: t.label ?? t.name.replace(/_/g, " "), onOpen: () => openStep(t.id) })),
  };

  // ---- Keyboard and Go to

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const inTerminal = e.target instanceof HTMLElement && !!e.target.closest(".xterm");
      if (mod && k === "p") { e.preventDefault(); e.stopPropagation(); setPalette(true); }
      else if (inTerminal) return;
      else if (mod && k === "b") { e.preventDefault(); set((l) => ({ sideOpen: !l.sideOpen })); }
      else if (mod && k === ".") { e.preventDefault(); set((l) => ({ cards: !l.cards })); }
      else if (e.altKey && !mod && k === "n") { e.preventDefault(); newPinChat(); }
      else if (e.altKey && !mod && k === "w" && activeTab) { e.preventDefault(); closeTabs([activeTab]); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  const tileCmd = (k: TileKind, label: string, icon: ReactNode): Command => ({ id: `tile-${k}`, label: layout.tiles.includes(k) ? `Close ${label}` : `Open ${label}`, group: "Commands", icon, run: () => toggleTile(k) });
  const commands: Command[] = [
    { id: "new", label: "New chat with Pin", group: "Commands", hint: "Alt+N", icon: <Sparkles className="h-4 w-4" />, run: newPinChat },
    tileCmd("plan", "the plan", <ListChecks className="h-4 w-4" />),
    tileCmd("files", "files", <FolderOpen className="h-4 w-4" />),
    tileCmd("terminal", "a terminal", <SquareTerminal className="h-4 w-4" />),
    tileCmd("artifacts", "artifacts", <Package className="h-4 w-4" />),
    tileCmd("prs", "pull requests", <GitPullRequest className="h-4 w-4" />),
    { id: "cards", label: layout.cards ? "Hide the cards" : "Show the cards", group: "Commands", hint: "Ctrl+.", icon: <PanelRight className="h-4 w-4" />, run: () => set((l) => ({ cards: !l.cards })) },
    { id: "side", label: layout.sideOpen ? "Hide the sidebar" : "Show the sidebar", group: "Commands", hint: "Ctrl+B", icon: <PanelLeft className="h-4 w-4" />, run: () => set((l) => ({ sideOpen: !l.sideOpen })) },
    { id: "read", label: "Mark all conversations as read", group: "Commands", icon: <CheckCheck className="h-4 w-4" />, run: () => markRead(everything) },
    { id: "back", label: "Back to the console", group: "Commands", icon: <ArrowLeft className="h-4 w-4" />, run: () => nav(`/${device}/home`) },
    ...heads.map((h): Command => ({ id: `tab-${h.id}`, label: h.title, group: "Open files", icon: h.icon, run: () => { setActiveTab(h.id); showTile("files"); } })),
    ...everything.map((c): Command => ({ id: `c-${c.key}`, label: c.title, group: "Conversations", icon: c.source === "pin" ? <PinOrb size={14} /> : <MessageCircle className="h-4 w-4" />, run: () => pick(c) })),
    ...allAgents.map((a): Command => ({ id: `a-${a.companyId}-${a.agentId}`, label: `Chat with ${a.name} (${a.org})`, group: "Agents", icon: <MessagesSquare className="h-4 w-4" />, run: () => open({ kind: "agent", companyId: a.companyId, agentId: a.agentId }) })),
  ];

  // ---- Layout

  const isWide = wide();
  const toggleTileFromToolbar = (k: TileKind) => { toggleTile(k); if (!isWide) setSheet((s) => (s === "tiles" && layout.tiles.includes(k) && layout.tiles.length === 1 ? null : "tiles")); };
  const share = () => { if (activeKey) { copyText(linkFor(everything.find((c) => c.key === activeKey) ?? { key: activeKey, source: view.kind === "pin" ? "pin" : "agent", title, updatedAt: 0 })); setShared(true); setTimeout(() => setShared(false), 1500); } };
  const showCards = layout.cards && isWide;
  const showTiles = openTiles.length > 0 && isWide;

  return (
    <div className="fixed inset-0 z-(--z-workspace) bg-bg flex" role="region" aria-label="PinView">
      {(layout.sideOpen || !onPhoneThread) && (
        <aside aria-label="Sidebar" className={cn("min-h-0 flex-col glass-bar border-r border-line", onPhoneThread ? "hidden md:flex" : layout.sideOpen ? "flex w-full md:w-auto" : "flex w-full md:hidden")} style={isWide ? { width: layout.sideWidth } : undefined}>
          <Sidebar groups={groups} activeKey={activeKey} onPick={pick} rowMenu={rowMenu} renaming={renaming}
            onRenamed={(r, t) => void pin.renameChat(r.key.slice(4), t).finally(() => setRenaming(null))} onCancelRename={() => setRenaming(null)}
            nav={{ newChat: newPinChat, search: () => setPalette(true), artifacts: () => toggleTileFromToolbar("artifacts"), files: () => toggleTileFromToolbar("files"), prs: () => toggleTileFromToolbar("prs"), automationsTo: `/${device}/pin?tab=automations`, customizeTo: `/${device}/pin?tab=settings`, active: undefined, prBadge: cards.changes?.failing ? <span className="text-xs text-critical">{cards.changes.failing}</span> : undefined }}
            onCollapse={() => set({ sideOpen: false })} back={{ can: history.current.at > 0, go: () => goHistory(-1) }} forward={{ can: history.current.at < history.current.list.length - 1, go: () => goHistory(1) }}
            user={setup?.ownerName || "You"} settingsTo={settingsHref("general")} device={device} />
        </aside>
      )}
      {layout.sideOpen && <ResizeHandle label="Sidebar width" value={layout.sideWidth} min={220} max={420} onChange={(v) => set({ sideWidth: v })} className="hidden md:block" />}

      <main className={cn("relative flex-1 min-w-0 flex-col min-h-0", onPhoneThread ? "flex" : "hidden md:flex")}>
        <div className="h-11 shrink-0 flex items-center gap-1 px-2 border-b border-line">
          <button type="button" onClick={toList} aria-label="Back to conversations" className="md:hidden h-8 w-8 rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 flex items-center justify-center"><ArrowLeft className="h-4 w-4" /></button>
          {!layout.sideOpen && <span className="hidden md:inline-flex"><ToolIcon label="Show the sidebar (Ctrl+B)" onClick={() => set({ sideOpen: true })}><PanelLeft className="h-4 w-4" /></ToolIcon></span>}
          <span className="pl-1">{view.kind === "pin" ? <PinOrb size={18} /> : <MessageCircle className="h-4 w-4 text-ink-3" aria-hidden />}</span>
          <h1 className="pl-1 text-compact font-medium truncate flex-1 min-w-0">{title}{current && <span className="text-ink-3 font-normal"> · {current.org}</span>}</h1>
          <ToolIcon label="Cards (Ctrl+.)" on={layout.cards} onClick={() => { set((l) => ({ cards: !l.cards })); if (!isWide) setSheet((s) => (s === "cards" ? null : "cards")); }}><PanelRight className="h-4 w-4" /></ToolIcon>
          <ToolIcon label="Plan" on={layout.tiles.includes("plan")} onClick={() => toggleTileFromToolbar("plan")} badge={running.length ? <span aria-hidden className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-accent" /> : undefined}><ListChecks className="h-4 w-4" /></ToolIcon>
          <ToolIcon label="Terminal" on={layout.tiles.includes("terminal")} onClick={() => toggleTileFromToolbar("terminal")}><SquareTerminal className="h-4 w-4" /></ToolIcon>
          <ToolIcon label="Files" on={layout.tiles.includes("files")} onClick={() => toggleTileFromToolbar("files")} badge={tabs.length ? <span aria-hidden className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-ink-3" /> : undefined}><FolderOpen className="h-4 w-4" /></ToolIcon>
          <Menu label="More" icon={<MoreHorizontal className="h-4 w-4" />} items={[
            { label: "Artifacts", icon: <Package className="h-4 w-4" />, onSelect: () => toggleTileFromToolbar("artifacts") },
            { label: "Pull requests", icon: <GitPullRequest className="h-4 w-4" />, onSelect: () => toggleTileFromToolbar("prs") },
            { kind: "separator" },
            ...(activeKey ? [{ label: pinned.has(activeKey) ? "Unpin" : "Pin to the sidebar", onSelect: () => togglePin(activeKey) }] : []),
            { label: "New chat with Pin", onSelect: newPinChat, shortcut: "Alt+N" },
            { label: "Search", onSelect: () => setPalette(true), shortcut: "Ctrl+P" },
          ]} />
          <button type="button" onClick={share} disabled={!activeKey} title={activeKey ? "Copy a link to this conversation" : "Send a message first"} className="transition-control ml-1 h-8 px-2.5 rounded-md inline-flex items-center gap-1.5 text-compact text-ink-2 hover:text-ink hover:bg-surface-2 disabled:opacity-40">
            {shared ? <Check className="h-4 w-4 text-good" /> : <Share className="h-4 w-4" />}<span className="hidden sm:inline">{shared ? "Copied" : "Share"}</span>
          </button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col w-full max-w-3xl mx-auto">
          {view.kind === "pin" ? (
            <PinThread inPlace autoFocus className="flex-1" empty={<div className="h-full flex flex-col items-center justify-center text-center gap-3 py-16 px-6"><PinOrb size={44} /><p className="text-ink-2 text-sm max-w-sm text-pretty">Ask Pin about this device, or tell it what to set up. In Agent mode it can act, inside machines too; its plan, files and commands open beside the chat.</p></div>}
              below={<div className="px-5 pb-3 -mt-1 flex items-center gap-3 text-xs text-ink-3"><span>{pin.settings?.mode === "agent" ? permission ?? "Agent" : "Assistant"}</span><span className="flex-1" /><span className="truncate">{pin.settings?.model ?? pin.providerName ?? "No model yet"}</span></div>} />
          ) : current && currentAgent ? (
            <AgentChat key={agentKey(current.companyId, current.agentId)} companyId={current.companyId} agent={currentAgent} org={current.org} />
          ) : (
            <div className="p-8"><Notice tone="info">That agent isn't available any more. Pick another conversation.</Notice></div>
          )}
        </div>
        {/* On a phone the cards and the tiles open as sheets over the conversation. */}
        {!isWide && sheet && (
          <div className="absolute inset-0 z-(--z-raised) bg-bg flex flex-col">
            <div className="h-11 shrink-0 flex items-center gap-2 px-2 border-b border-line">
              <ToolIcon label="Back to the conversation" onClick={() => setSheet(null)}><ArrowLeft className="h-4 w-4" /></ToolIcon>
              <span className="text-compact font-medium">{sheet === "cards" ? "Details" : "Tiles"}</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">{sheet === "cards" ? <div className="p-3"><Cards m={cards} /></div> : <TileStack tiles={openTiles} heights={layout.tileHeights} onHeight={(k, h) => set((l) => ({ tileHeights: { ...l.tileHeights, [k]: h } }))} expanded={expanded} onExpand={setExpanded} onClose={(k) => { closeTile(k); if (layout.tiles.length <= 1) setSheet(null); }} />}</div>
          </div>
        )}
      </main>

      {showCards && <aside aria-label="Cards" className="w-80 shrink-0 border-l border-line overflow-y-auto p-3 bg-bg"><Cards m={cards} /></aside>}
      {showTiles && (
        <>
          <ResizeHandle label="Tiles width" value={layout.tilesWidth} min={340} max={1000} edge="start" onChange={(v) => set({ tilesWidth: v })} />
          <aside aria-label="Tiles" className="shrink-0 border-l border-line min-h-0" style={{ width: layout.tilesWidth }}>
            <TileStack tiles={openTiles} heights={layout.tileHeights} onHeight={(k, h) => set((l) => ({ tileHeights: { ...l.tileHeights, [k]: h } }))} expanded={expanded} onExpand={setExpanded} onClose={closeTile} />
          </aside>
        </>
      )}

      {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}
      {closing && (
        <ConfirmModal title="Close without saving?" label="Close without saving" danger
          body={`${closing.filter((i) => dirty.has(i)).length === 1 ? "A file has" : "Some files have"} changes that aren't saved to the machine. They will be lost.`}
          onConfirm={() => { const list = closing; setClosing(null); setDirty((d) => new Set([...d].filter((i) => !list.includes(i)))); closeTabs(list, true); }} onClose={() => setClosing(null)} />
      )}
      {deleting && (
        <ConfirmModal title={`Delete "${deleting.title}"?`} label="Delete" danger body="The conversation is removed from this device. This can't be undone."
          onConfirm={() => { const r = deleting; setDeleting(null); void pin.deleteChat(r.key.slice(4)); }} onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}

/** An organization's chat with one agent, drawn by the same thread as Pin's: each comment on the conversation task is a message. */
function AgentChat({ companyId, agent, org }: { companyId: string; agent: Agent; org: string }) {
  const names = useNames(companyId);
  const chats = useChats(companyId, true);
  const w = useChatWrites(companyId);
  const send = useSendChat(companyId);
  const containers = useAgentContainers();
  const canRun = useAgentsCanRun();
  const conv = (chats.data ?? []).find((c) => c.conversationAgentId === agent.id) ?? null;
  const comments = useComments(conv ? companyId : null, conv?.id ?? "");
  const runs = useRuns(conv ? companyId : null, agent.id);
  const [error, setError] = useState<string | null>(null);
  const block = chatBlock({ agent, run: runs.data?.[0] ?? null, conversationStartedAt: conv?.createdAt ?? null, containersReady: containers.data ? containers.data.state === "ready" : undefined, canManageContainers: containers.data?.canManage });
  const writing = conv?.conversationState === "active" && !block && canRun && agent.status !== "error";

  const messages: ThreadMessage[] = (comments.data ?? []).map((c) => (c.authorAgentId ? { id: c.id, from: "agent" as const, name: names.agent(c.authorAgentId), text: c.body } : { id: c.id, from: "you" as const, text: c.body }));
  if (writing) messages.push({ id: "writing", from: "agent", name: agent.name, text: "", streaming: true });

  const api: ThreadApi = {
    messages,
    thinking: false,
    streaming: writing,
    name: agent.name,
    stop: () => undefined,
    markDone: () => undefined,
    resolveTool: () => undefined,
    send: (text) => {
      const body = text.trim();
      if (!body) return;
      setError(null);
      void (async () => {
        try {
          // The conversation is created the first time you write, as the engine intends.
          const id = conv?.id ?? (await w.open.mutateAsync(agent.id)).id;
          await send.mutateAsync({ issueId: id, body });
        } catch (e) {
          setError(errorText(e));
        }
      })();
    },
  };
  return (
    <ThreadProvider value={api}>
      <PinThread inPlace autoFocus className="flex-1" empty={<p className="text-sm text-ink-3 py-8 text-center">No messages yet. Say hello to {agent.name}.</p>}
        below={<div className="px-5 pb-3 -mt-1 flex items-center gap-3 text-xs text-ink-3"><span>{agentStatusOf(agent.status)[1]}</span><span className="flex-1" /><span className="truncate">{org}</span></div>}
        footer={(block || error) ? (
          <div className="px-4 space-y-2">
            {block && <Notice tone="warning" title={block.reason}>{block.todo}</Notice>}
            {error && <p role="alert" className="text-compact text-critical">{error}</p>}
          </div>
        ) : undefined} />
    </ThreadProvider>
  );
}
