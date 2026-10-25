import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Building2, CheckCheck, PanelLeft, ChevronDown, ChevronRight, ClipboardList, FileText, FolderTree, GitPullRequest, HardDrive, MessageCircle, MessagesSquare, MoreHorizontal, Package, PanelBottom, PanelRight, SquareTerminal, Sparkles } from "lucide-react";
import type { Agent, CompanyArtifact } from "@papercliped-engine/engine-client";
import { useAgentsCanRun } from "../containers/Banner.tsx";
import { chatBlock, useSendChat } from "../../data/engine/chat.ts";
import { githubApi } from "../../data/engine/githubApi.ts";
import { useChats, useChatsOf, useChatWrites } from "../../data/engine/more.ts";
import { agentStatusOf } from "../../data/engine/labels.tsx";
import { engine as engineApi, errorText, useAgentContainers, useAgentsOf, useComments, useConnectors, useRuns } from "../../data/engine/queries.ts";
import { useEngine } from "../../data/store.tsx";
import { cn, readJson, writeJson } from "../../lib/storage.ts";
import { settingsHref } from "../../modals/useModals.ts";
import type { ConversationItem, ConversationSection } from "../../pin/ConversationList.tsx";
import { PERMISSION_INFO, PermissionPicker } from "../../pin/PermissionPicker.tsx";
import { usePin } from "../../pin/PinContext.tsx";
import { PinOrb } from "../../pin/PinOrb.tsx";
import { PinThread } from "../../pin/PinThread.tsx";
import { ThreadProvider, type ThreadApi } from "../../pin/ThreadContext.tsx";
import type { ThreadMessage } from "../../pin/useThread.ts";
import { Menu, Notice, ResizeHandle, Status, type MenuEntry } from "../../ui/primitives.tsx";
import { ConfirmModal } from "../../ui/Confirm.tsx";
import { Preview } from "../org/live/LiveArtifacts.tsx";
import { useNames } from "../org/live/names.ts";
import { ChangesBody, PullRequestList, useGithub } from "./Changes.tsx";
import { FilesPanel } from "./FilesPanel.tsx";
import { FileEditor } from "./MachineFiles.tsx";
import { copyText, TileView } from "./TileView.tsx";
import { tilesOf, type Tile } from "./tiles.ts";
import { SEEN, SINCE } from "./unread.ts";
import { BottomPanel } from "./workspace/BottomPanel.tsx";
import { ActivityBar, Palette, StatusBar, type Command } from "./workspace/chrome.tsx";
import { ChatsView, type AgentChoice } from "./workspace/ChatsView.tsx";
import { EditorGroup, type TabHead } from "./workspace/EditorGroup.tsx";
import { Explorer } from "./workspace/Explorer.tsx";
import { useLayout, type SideView } from "./workspace/layout.ts";
import { BarButton, SideHeader } from "./workspace/parts.tsx";

/**
 * PinView: a focused workspace for working with Pin and your agents, laid out like an editor in the browser.
 *
 *   activity bar | side panel (Conversations, Explorer, Artifacts, Pull requests) | conversation | editor tabs | details
 *                                                                    panel: Terminal, Steps
 *                                              status bar
 *
 * Files from a machine, the files and plans Pin's steps touch, artifacts and pull requests open as tabs beside the
 * conversation (a step's tab is a preview, replaced by the next until you keep it). The panel holds a real terminal and
 * Pin's steps. Everything resizes, folds away and is remembered per browser. Ctrl/Cmd+P goes to anything; Ctrl/Cmd+B,
 * Ctrl/Cmd+J and Ctrl/Cmd+. toggle the side panel, the panel and the details. On a phone each part is a pane of its own.
 */

type View = { kind: "pin" } | { kind: "agent"; companyId: string; agentId: string };
type ETab = { id: string; preview: boolean } & (
  | { kind: "tool"; toolId: string }
  | { kind: "file"; vmid: number; path: string; edit?: boolean }
  | { kind: "artifact"; artifact: CompanyArtifact }
  | { kind: "prs" }
);
const agentKey = (companyId: string, agentId: string) => `agent:${companyId}:${agentId}`;
const PINNED = "epc.pinview.pinned";
const HIDDEN = "epc.pinview.hidden";
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const wide = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1024px)").matches;
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** A card in the details column, folded away by its heading; `action` sits at the right of the heading. */
function DetailCard({ title, children, open: start = true, action }: { title: string; children: ReactNode; open?: boolean; action?: ReactNode }) {
  const [open, setOpen] = useState(start);
  return (
    <section aria-label={title} className="rounded-xl border border-line bg-surface">
      <div className="flex items-center pr-2">
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="transition-control flex-1 flex items-center gap-1.5 px-4 py-3 text-compact font-medium text-left">
          {title}{open ? <ChevronDown className="h-3.5 w-3.5 text-ink-3" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5 text-ink-3" aria-hidden />}
        </button>
        {action}
      </div>
      {open && <div className="px-4 pb-4 space-y-3">{children}</div>}
    </section>
  );
}

const Fact = ({ label, children }: { label: string; children: ReactNode }) => <div><div className="text-xs text-ink-3">{label}</div><div className="text-compact">{children}</div></div>;

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
  const { layout, set, showSide } = useLayout();
  const [tabs, setTabs] = useState<ETab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [closedTools, setClosedTools] = useState<ReadonlySet<string>>(new Set());
  const [palette, setPalette] = useState(false);
  const [editingGithub, setEditingGithub] = useState(false);
  const [filesOrg, setFilesOrg] = useState<string | null>(null);
  const [explorerVmid, setExplorerVmid] = useState<number | null>(null);
  const [mobilePane, setMobilePane] = useState<null | "editor" | "details" | "panel">(null);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set(readJson<string[]>(PINNED, [])));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set(readJson<string[]>(HIDDEN, [])));
  const [scope, setScope] = useState<string>("all");
  const [since] = useState<number>(() => { const v = readJson<number | null>(SINCE, null); if (v === null) { const n = Date.now(); writeJson(SINCE, n); return n; } return v; });
  const [seenAt, setSeenAt] = useState<Record<string, number>>(() => readJson<Record<string, number>>(SEEN, {}));
  const activeKeyRef = useRef<string | null>(null);
  const orgs = data.orgs.flatMap((o) => (o.engine ? [{ name: o.name, slug: o.slug, hue: o.hue, companyId: o.engine.companyId }] : []));
  const ids = orgs.map((o) => o.companyId);
  const agents = useAgentsOf(ids);
  const chats = useChatsOf(ids);
  const togglePin = useCallback((c: ConversationItem) => setPinned((prev) => { const n = new Set(prev); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); writeJson(PINNED, [...n]); return n; }), []);
  const setCard = (id: string, show: boolean) => setHidden((prev) => { const n = new Set(prev); if (show) n.delete(id); else n.add(id); writeJson(HIDDEN, [...n]); return n; });

  const view: View = useMemo(() => {
    const [kind, companyId, agentId] = (params.get("c") ?? "").split(":");
    return kind === "agent" && companyId && agentId ? { kind: "agent", companyId, agentId } : { kind: "pin" };
  }, [params]);
  /** Opens a conversation; `t` is what a phone uses to show the conversation instead of the side panel. */
  const open = (v: View) => setParams((p) => { const n = new URLSearchParams(p); n.delete("chat"); if (v.kind === "pin") n.delete("c"); else n.set("c", `agent:${v.companyId}:${v.agentId}`); n.set("t", "1"); return n; }, { replace: true });
  const toList = () => setParams((p) => { const n = new URLSearchParams(p); n.delete("t"); return n; }, { replace: true });
  const onMobileThread = !!params.get("t");

  const linked = params.get("chat");
  useEffect(() => {
    if (linked && linked !== pin.chatId) void pin.openChat(linked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked]);

  const agentName = (companyId: string, agentId: string) => agents[ids.indexOf(companyId)]?.data?.find((a) => a.id === agentId)?.name ?? "Agent";
  const allAgents: AgentChoice[] = orgs.flatMap((o, i) => (agents[i]?.data ?? []).filter((a) => a.status !== "terminated").map((a) => ({ companyId: o.companyId, org: o.name, agentId: a.id, name: a.name })));

  const sections: ConversationSection[] = useMemo(() => {
    const unread = (key: string, at: number) => key !== activeKeyRef.current && at > (seenAt[key] ?? since);
    const item = (key: string, source: "pin" | "agent", title: string, context: string, at: number): ConversationItem => ({ key, source, title, context, updatedAt: at, unread: unread(key, at) });
    const pinItems = pin.chats.map((c) => item(`pin:${c.id}`, "pin", c.title, "Pin", new Date(c.updatedAt).getTime()));
    const byOrg = orgs.map((org, i) => ({ org, items: (chats[i]?.data ?? []).flatMap((c) => (c.conversationAgentId ? [item(agentKey(org.companyId, c.conversationAgentId), "agent", agentName(org.companyId, c.conversationAgentId), org.name, new Date(c.updatedAt).getTime())] : [])) }));
    const inScope = (c: ConversationItem, orgId: string | null) => scope === "all" || (scope === "unread" ? !!c.unread : scope === "pin" ? c.source === "pin" : orgId === scope);
    const tagged = [...pinItems.map((c) => ({ c, org: null as string | null })), ...byOrg.flatMap((o) => o.items.map((c) => ({ c, org: o.org.companyId as string | null })))];
    const star = tagged.filter((t) => pinned.has(t.c.key) && inScope(t.c, t.org)).map((t) => t.c);
    const rest = (xs: ConversationItem[], orgId: string | null) => xs.filter((c) => !pinned.has(c.key) && inScope(c, orgId));
    const readAll = (xs: ConversationItem[]): MenuEntry => ({ label: "Mark as read", disabled: !xs.some((c) => c.unread), onSelect: () => markRead(xs) });
    const orgSections = byOrg.filter((o) => scope === "all" || scope === "unread" || scope === o.org.companyId).map((o) => {
      const theirs = allAgents.filter((a) => a.companyId === o.org.companyId);
      return {
        id: o.org.companyId,
        label: o.org.name,
        icon: <Building2 className="h-3.5 w-3.5" aria-hidden />,
        items: rest(o.items, o.org.companyId),
        empty: scope === o.org.companyId ? `No chats with ${o.org.name}'s agents yet.` : undefined,
        actions: [
          ...(theirs.length ? [{ kind: "heading" as const, label: "New chat with" }, ...theirs.map((a): MenuEntry => ({ label: a.name, onSelect: () => open({ kind: "agent", companyId: a.companyId, agentId: a.agentId }) }))] : []),
          { kind: "separator" as const },
          readAll(o.items),
          { label: "Show only this organization", onSelect: () => setScope(o.org.companyId), disabled: scope === o.org.companyId },
        ],
      };
    });
    return [
      ...(star.length ? [{ id: "pinned", label: "Pinned", items: star, actions: [readAll(star)] }] : []),
      ...(scope === "all" || scope === "unread" || scope === "pin" ? [{ id: "pin", label: "Pin", icon: <PinOrb size={14} />, items: rest(pinItems, null), empty: scope === "unread" ? undefined : "No chats yet. Start one with the pen above.", actions: [{ label: "New chat with Pin", onSelect: () => { pin.newChat(); open({ kind: "pin" }); } }, readAll(pinItems)] }] : []),
      ...orgSections,
    ].filter((sec) => scope !== "unread" || sec.items.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin.chats, pinned, scope, seenAt, since, chats.map((q) => q.dataUpdatedAt).join(), agents.map((q) => q.dataUpdatedAt).join(), ids.join()]);

  const activeKey = view.kind === "agent" ? agentKey(view.companyId, view.agentId) : pin.chatId ? `pin:${pin.chatId}` : null;
  activeKeyRef.current = activeKey;
  const everything = sections.flatMap((x) => x.items);
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
  const unreadCount = new Set(everything.filter((c) => c.unread).map((c) => c.key)).size;
  function markRead(xs: ConversationItem[]) {
    const n = Date.now();
    setSeenAt((p) => { const m = { ...p, ...Object.fromEntries(xs.map((c) => [c.key, Math.max(n, c.updatedAt)])) }; writeJson(SEEN, m); return m; });
  }
  const markAllRead = () => markRead(everything);

  const current = view.kind === "agent" ? allAgents.find((a) => a.companyId === view.companyId && a.agentId === view.agentId) : null;
  const currentAgent = current ? agents[ids.indexOf(current.companyId)]?.data?.find((a) => a.id === current.agentId) ?? null : null;
  const orgOfCurrent = current ? orgs.find((o) => o.companyId === current.companyId) : null;
  const permission = PERMISSION_INFO.find((p) => p.id === pin.settings?.permission)?.label;
  const title = view.kind === "pin" ? (pin.chats.find((c) => c.id === pin.chatId)?.title ?? "New chat") : current?.name ?? "Agent";
  const configured = (connectors.data?.connectors ?? []).filter((c) => c.configured);
  const linkFor = (c: ConversationItem) => `${window.location.origin}/${device}/view?${c.source === "pin" ? `chat=${encodeURIComponent(c.key.slice(4))}` : `c=${encodeURIComponent(c.key)}`}`;

  // ---- Editor tabs

  const openTab = useCallback((t: ETab, focus = true) => {
    setTabs((list) => {
      const at = list.findIndex((x) => x.id === t.id);
      if (at >= 0) return list.map((x, i) => (i === at ? { ...x, ...t, preview: x.preview && t.preview } : x));
      const pre = t.preview ? list.findIndex((x) => x.preview && !dirtyRef.current.has(x.id)) : -1;
      if (pre >= 0) return list.map((x, i) => (i === pre ? t : x));
      return [...list, t];
    });
    if (focus) setActiveTab(t.id);
    if (!wide()) setMobilePane("editor");
  }, []);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const [closing, setClosing] = useState<string[] | null>(null);
  const closeTabs = (ids_: string[], force = false) => {
    if (!force && ids_.some((i) => dirty.has(i))) { setClosing(ids_); return; }
    const toolIds = tabs.filter((t) => ids_.includes(t.id) && t.kind === "tool").map((t) => (t as { toolId: string }).toolId);
    if (toolIds.length) setClosedTools((c) => new Set([...c, ...toolIds]));
    setTabs((list) => {
      const left = list.filter((t) => !ids_.includes(t.id));
      if (activeTab && ids_.includes(activeTab)) {
        const i = list.findIndex((t) => t.id === activeTab);
        setActiveTab((left[Math.min(i, left.length - 1)] ?? null)?.id ?? null);
      }
      if (!left.length) setMobilePane((p) => (p === "editor" ? null : p));
      return left;
    });
  };
  const keep = (id: string) => setTabs((list) => list.map((t) => (t.id === id ? { ...t, preview: false } : t)));
  const openFile = (vmid: number, path: string, edit = false) => openTab({ id: `file:${vmid}:${path}`, kind: "file", vmid, path, edit, preview: false });
  const openArtifact = (a: CompanyArtifact) => openTab({ id: `artifact:${a.id}`, kind: "artifact", artifact: a, preview: true });
  const openPrs = () => openTab({ id: "prs", kind: "prs", preview: false });

  // Pin's steps: a file it read or wrote, a command and a plan open as a preview tab while it works (the newest replaces the last
  // preview); closing one keeps it closed. Agent chats have no steps in the engine yet.
  const tiles = useMemo(() => (view.kind === "pin" ? tilesOf(pin.messages, new Set()) : []), [view.kind, pin.messages]);
  const tileById = useMemo(() => new Map(tiles.map((t) => [t.id, t])), [tiles]);
  const seenTiles = useRef(new Set<string>());
  useEffect(() => {
    const fresh = tiles.filter((t) => !seenTiles.current.has(t.id) && !closedTools.has(t.id));
    tiles.forEach((t) => seenTiles.current.add(t.id));
    const last = fresh[fresh.length - 1];
    if (last && wide()) openTab({ id: `tool:${last.id}`, kind: "tool", toolId: last.id, preview: true });
  }, [tiles, closedTools, openTab]);
  const openStep = (toolId: string) => {
    if (tileById.has(toolId)) openTab({ id: `tool:${toolId}`, kind: "tool", toolId, preview: false });
    else set({ bottomOpen: true, bottomTab: "steps" });
  };

  const iconFor = (t: ETab | Tile) => {
    const k = "toolId" in t ? tileById.get(t.toolId)?.kind : t.kind;
    return k === "file" ? <FileText className="h-3.5 w-3.5 text-ink-3" /> : k === "command" ? <SquareTerminal className="h-3.5 w-3.5 text-ink-3" /> : k === "plan" ? <ClipboardList className="h-3.5 w-3.5 text-ink-3" /> : k === "artifact" ? <Package className="h-3.5 w-3.5 text-ink-3" /> : k === "prs" ? <GitPullRequest className="h-3.5 w-3.5 text-ink-3" /> : <FileText className="h-3.5 w-3.5 text-ink-3" />;
  };
  const heads: TabHead[] = tabs.map((t) => {
    if (t.kind === "tool") { const tile = tileById.get(t.toolId); return { id: t.id, title: tile?.title ?? "Step", icon: iconFor(t), preview: t.preview, hint: tile?.kind === "file" ? tile.path : tile?.kind === "command" ? tile.command : tile?.title }; }
    if (t.kind === "file") return { id: t.id, title: base(t.path), icon: iconFor(t), preview: t.preview, dirty: dirty.has(t.id), hint: `${machines.find((m) => m.vmid === t.vmid)?.name ?? t.vmid}: ${t.path}` };
    if (t.kind === "artifact") return { id: t.id, title: t.artifact.title, icon: iconFor(t), preview: t.preview, hint: `${t.artifact.issue.identifier}: ${t.artifact.title}` };
    return { id: t.id, title: "Pull requests", icon: iconFor(t), preview: false };
  });
  const active = tabs.find((t) => t.id === activeTab) ?? tabs[tabs.length - 1] ?? null;

  const editorContent = (t: ETab | null): ReactNode => {
    if (!t) return null;
    if (t.kind === "tool") {
      const tile = tileById.get(t.toolId);
      if (!tile) return <div className="p-6"><Notice tone="info">This step belongs to another conversation. Open that conversation to see it.</Notice></div>;
      return <TileView key={t.id} tab tile={tile} device={device} expanded={false} onExpand={() => undefined} onClose={() => closeTabs([t.id])} onEditLive={(vmid, path) => openFile(vmid, path, true)} />;
    }
    if (t.kind === "file") return <FileEditor key={t.id} tab vmid={t.vmid} path={t.path} startEditing={t.edit} machineName={machines.find((g) => g.vmid === t.vmid)?.name} expanded={false} onExpand={() => undefined} onClose={() => closeTabs([t.id])} onDirty={(d) => { setDirty((s) => { const n = new Set(s); if (d) n.add(t.id); else n.delete(t.id); return n; }); if (d) keep(t.id); }} />;
    if (t.kind === "artifact") {
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
    }
    return (
      <div className="h-full overflow-auto p-4 space-y-3">
        {github.status.data?.connected ? <PullRequestList prs={github.prs.data?.prs ?? []} /> : <ChangesBody onShowAll={() => undefined} editing={false} onEdited={() => undefined} />}
      </div>
    );
  };

  // ---- Keyboard

  useEffect(() => {
    // Listened for before anything else (the terminal keeps the keys it handles); inside the terminal only Go to is taken,
    // so Ctrl+B, Ctrl+J and the rest still reach the shell.
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const inTerminal = e.target instanceof HTMLElement && !!e.target.closest(".xterm");
      if (mod && k === "p") { e.preventDefault(); e.stopPropagation(); setPalette(true); }
      else if (inTerminal) return;
      else if (mod && k === "b") { e.preventDefault(); set((l) => ({ sideOpen: !l.sideOpen })); }
      else if (mod && k === "j") { e.preventDefault(); set((l) => ({ bottomOpen: !l.bottomOpen })); }
      else if (mod && k === ".") { e.preventDefault(); set((l) => ({ details: !l.details })); }
      else if (e.altKey && k === "n" && !mod) { e.preventDefault(); pin.newChat(); open({ kind: "pin" }); }
      else if (e.altKey && k === "w" && !mod && activeTab) { e.preventDefault(); closeTabs([activeTab]); }
      else if (e.key === "Escape" && !typing(e.target) && mobilePane) setMobilePane(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // ---- Palette

  const commands: Command[] = [
    { id: "new", label: "New chat with Pin", group: "Commands", hint: "Alt+N", icon: <Sparkles className="h-4 w-4" />, run: () => { pin.newChat(); open({ kind: "pin" }); } },
    { id: "side", label: layout.sideOpen ? "Hide the side panel" : "Show the side panel", group: "Commands", hint: "Ctrl+B", icon: <PanelLeft className="h-4 w-4" />, run: () => set((l) => ({ sideOpen: !l.sideOpen })) },
    { id: "panel", label: layout.bottomOpen ? "Hide the panel" : "Show the panel", group: "Commands", hint: "Ctrl+J", icon: <PanelBottom className="h-4 w-4" />, run: () => set((l) => ({ bottomOpen: !l.bottomOpen })) },
    { id: "terminal", label: "Open a terminal", group: "Commands", icon: <SquareTerminal className="h-4 w-4" />, run: () => set({ bottomOpen: true, bottomTab: "terminal" }) },
    { id: "details", label: layout.details ? "Hide details" : "Show details", group: "Commands", hint: "Ctrl+.", icon: <PanelRight className="h-4 w-4" />, run: () => set((l) => ({ details: !l.details })) },
    { id: "explorer", label: "Show the Explorer", group: "Commands", icon: <FolderTree className="h-4 w-4" />, run: () => set({ side: "explorer", sideOpen: true }) },
    { id: "artifacts", label: "Show artifacts", group: "Commands", icon: <Package className="h-4 w-4" />, run: () => set({ side: "artifacts", sideOpen: true }) },
    { id: "prs", label: "Open pull requests", group: "Commands", icon: <GitPullRequest className="h-4 w-4" />, run: openPrs },
    { id: "read", label: "Mark all conversations as read", group: "Commands", icon: <CheckCheck className="h-4 w-4" />, run: markAllRead },
    { id: "back", label: "Back to the console", group: "Commands", icon: <ArrowLeft className="h-4 w-4" />, run: () => nav(`/${device}/home`) },
    ...heads.map((h): Command => ({ id: `tab-${h.id}`, label: h.title, group: "Open editors", hint: undefined, icon: h.icon, run: () => setActiveTab(h.id) })),
    ...everything.map((c): Command => ({ id: `c-${c.key}`, label: c.title, group: "Conversations", icon: c.source === "pin" ? <PinOrb size={14} /> : <MessageCircle className="h-4 w-4" />, run: () => pickConversation(c) })),
    ...allAgents.map((a): Command => ({ id: `a-${a.companyId}-${a.agentId}`, label: `Chat with ${a.name} (${a.org})`, group: "Agents", icon: <MessagesSquare className="h-4 w-4" />, run: () => open({ kind: "agent", companyId: a.companyId, agentId: a.agentId }) })),
  ];
  function pickConversation(c: ConversationItem) {
    if (c.source === "pin") { void pin.openChat(c.key.slice(4)); open({ kind: "pin" }); }
    else { const [, companyId, agentId] = c.key.split(":"); open({ kind: "agent", companyId: companyId!, agentId: agentId! }); }
  }

  // ---- Details

  const cardsFor: { id: string; label: string }[] = view.kind === "pin"
    ? [{ id: "model", label: "Model" }, { id: "permissions", label: "Permissions" }, { id: "connectors", label: "Connectors" }, { id: "changes", label: "Changes" }]
    : [{ id: "agent", label: "Agent" }, { id: "organization", label: "Organization" }, { id: "files", label: "Files" }, { id: "changes", label: "Changes" }];
  const showMenu: MenuEntry[] = [
    { kind: "heading", label: "Show" },
    ...cardsFor.map((c): MenuEntry => ({ kind: "check", label: c.label, checked: !hidden.has(c.id), onToggle: (v) => setCard(c.id, v) })),
    { kind: "separator" },
    { label: "Reset to defaults", onSelect: () => { setHidden(new Set()); writeJson(HIDDEN, []); } },
  ];
  const visible = (id: string) => !hidden.has(id);
  const changesAction = github.status.data?.connected && github.status.data.canManage ? (
    <Menu size="sm" label="Changes options" icon={<MoreHorizontal className="h-4 w-4" />} items={[
      { label: "Show all pull requests", onSelect: openPrs },
      { label: "Refresh", onSelect: () => void qc.invalidateQueries({ queryKey: ["github", "prs"] }) },
      { label: "Change token or repositories", onSelect: () => setEditingGithub(true) },
      { kind: "separator" },
      { label: "Disconnect GitHub", danger: true, onSelect: () => void githubApi.disconnect().then((s) => qc.setQueryData(["github", "status"], s)) },
    ]} />
  ) : undefined;
  const detailsPanel = (
    <aside aria-label="Details" className={cn("bg-bg flex flex-col min-h-0 border-l border-line", mobilePane === "details" ? "absolute inset-0 z-(--z-raised) md:static md:w-80" : "hidden lg:flex w-80 shrink-0")}>
      <div className="h-10 shrink-0 flex items-center gap-1 pl-4 pr-2 border-b border-line">
        <h2 className="flex-1 text-micro font-semibold uppercase tracking-label text-ink-3">Details</h2>
        <Menu size="sm" label="Show cards" icon={<MoreHorizontal className="h-4 w-4" />} items={showMenu} />
        <BarButton label="Close details" onClick={() => { set({ details: false }); setMobilePane(null); }}><PanelRight className="h-4 w-4" /></BarButton>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {view.kind === "pin" ? (
          <>
            {visible("model") && <DetailCard title="Model"><Fact label="Provider">{pin.providerName ?? "Not set up"}</Fact><Fact label="Model">{pin.settings?.model ?? "None chosen"}</Fact><Link to={`/${device}/pin?tab=settings`} className="text-compact text-accent hover:underline">Change in Pin's settings</Link></DetailCard>}
            {visible("permissions") && <DetailCard title="Permissions"><Fact label="Mode">{pin.settings?.mode === "agent" ? "Agent" : "Assistant"}</Fact><PermissionPicker /></DetailCard>}
            {visible("connectors") && (
              <DetailCard title="Connectors" open={configured.length > 0}>
                {configured.length === 0 ? <p className="text-compact text-ink-3">No connectors are set up yet.</p> : <ul className="space-y-1.5">{configured.map((c) => <li key={c.id} className="flex items-center gap-2 text-compact"><span className="flex-1 truncate">{c.label ?? c.id}</span><Status kind={pin.settings?.connectors.includes(c.id) ? "good" : "idle"} label={pin.settings?.connectors.includes(c.id) ? "Pin uses it" : "Not used"} /></li>)}</ul>}
                <Link to={settingsHref("connectors")} className="text-compact text-accent hover:underline">Manage connectors</Link>
              </DetailCard>
            )}
          </>
        ) : current ? (
          <>
            {visible("agent") && <DetailCard title="Agent"><Fact label="Name">{current.name}</Fact>{currentAgent && <div><div className="text-xs text-ink-3 mb-1">Status</div><Status kind={agentStatusOf(currentAgent.status)[0]} label={agentStatusOf(currentAgent.status)[1]} /></div>}<Link to={`/${device}/${orgOfCurrent?.slug ?? ""}/agents/${current.agentId}`} className="text-compact text-accent hover:underline">Open the agent</Link></DetailCard>}
            {visible("organization") && <DetailCard title="Organization"><Fact label="Name"><span className="inline-flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5 text-ink-3" aria-hidden />{current.org}</span></Fact><Link to={`/${device}/${orgOfCurrent?.slug ?? ""}`} className="text-compact text-accent hover:underline">Open the organization</Link></DetailCard>}
            {visible("files") && <DetailCard title="Files"><p className="text-compact text-ink-3 text-pretty">Documents and files this organization's agents produced.</p><button type="button" onClick={() => { setFilesOrg(current.companyId); set({ side: "artifacts", sideOpen: true }); }} className="text-compact text-accent hover:underline">Show artifacts</button></DetailCard>}
          </>
        ) : null}
        {visible("changes") && <DetailCard title="Changes" action={changesAction}><ChangesBody onShowAll={openPrs} editing={editingGithub} onEdited={() => setEditingGithub(false)} /></DetailCard>}
        {cardsFor.every((c) => hidden.has(c.id)) && <p className="text-compact text-ink-3 px-1">Every card is hidden. Choose some from the menu above.</p>}
      </div>
    </aside>
  );

  // ---- Side panel views

  const sideViews: Record<SideView, ReactNode> = {
    chats: (
      <ChatsView sections={sections} activeKey={activeKey} onPick={pickConversation} onNewPin={() => { pin.newChat(); open({ kind: "pin" }); }} onNewAgent={(a) => open({ kind: "agent", companyId: a.companyId, agentId: a.agentId })}
        agents={allAgents} scope={scope} setScope={setScope} scopes={[{ id: "all", label: "All conversations" }, { id: "unread", label: "Unread" }, { id: "pin", label: "Pin only" }, ...orgs.map((o) => ({ id: o.companyId, label: o.name }))]}
        unreadCount={unreadCount} markAllRead={markAllRead} pinned={pinned} onTogglePin={togglePin} linkFor={linkFor}
        onRename={(c, t) => (c.source === "pin" ? pin.renameChat(c.key.slice(4), t) : Promise.reject(new Error("Agent chats are named after the agent.")))}
        onDelete={(c) => (c.source === "pin" ? pin.deleteChat(c.key.slice(4)) : Promise.reject(new Error("An agent chat lives in its organization; delete its task there.")))}
        emptyNote={live ? undefined : "Chats are kept on a device; the demo doesn't save them."} />
    ),
    explorer: <Explorer machines={machines} vmid={explorerVmid} onVmid={setExplorerVmid} onOpenFile={(vmid, path) => openFile(vmid, path)} activePath={active?.kind === "file" && active.vmid === explorerVmid ? active.path : null} />,
    artifacts: (
      <div className="flex flex-col min-h-0 h-full">
        <SideHeader title="Artifacts" />
        <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3"><FilesPanel orgs={orgs} companyId={filesOrg ?? (view.kind === "agent" ? view.companyId : orgs[0]?.companyId ?? null)} onOrg={setFilesOrg} onOpen={openArtifact} /></div>
      </div>
    ),
    prs: (
      <div className="flex flex-col min-h-0 h-full">
        <SideHeader title="Pull requests" actions={github.status.data?.connected ? <BarButton label="Open in the editor" onClick={openPrs}><GitPullRequest className="h-3.5 w-3.5" /></BarButton> : undefined} />
        <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 space-y-3"><ChangesBody onShowAll={openPrs} editing={editingGithub} onEdited={() => setEditingGithub(false)} /></div>
      </div>
    ),
    search: null,
  };

  // ---- Layout

  const conversation = (
    <section aria-label="Conversation" className="flex-1 min-w-0 flex flex-col min-h-0">
      <div className="h-10 shrink-0 border-b border-line flex items-center gap-2 px-3">
        <button type="button" onClick={toList} aria-label="Back to conversations" className="md:hidden h-8 w-8 rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 flex items-center justify-center"><ArrowLeft className="h-4 w-4" /></button>
        <span>{view.kind === "pin" ? <PinOrb size={18} /> : <MessageCircle className="h-4 w-4 text-ink-3" aria-hidden />}</span>
        <h1 className="text-compact font-medium truncate flex-1 min-w-0">{title}{orgOfCurrent && <span className="text-ink-3 font-normal"> · {orgOfCurrent.name}</span>}</h1>
        {tabs.length > 0 && <span className="md:hidden"><BarButton label={`Open editors (${tabs.length})`} onClick={() => setMobilePane("editor")}><FileText className="h-4 w-4" /></BarButton></span>}
        <span className="lg:hidden"><BarButton label="Details" onClick={() => setMobilePane("details")}><PanelRight className="h-4 w-4" /></BarButton></span>
        <Menu size="sm" label="Conversation menu" icon={<MoreHorizontal className="h-4 w-4" />} items={[
          ...(view.kind === "pin" && pin.chatId ? [{ label: "Copy link", onSelect: () => copyText(`${window.location.origin}/${device}/view?chat=${pin.chatId}`) }] : []),
          ...(activeKey ? [{ label: pinned.has(activeKey) ? "Unpin" : "Pin to the top", onSelect: () => { const c = everything.find((x) => x.key === activeKey); if (c) togglePin(c); } }] : []),
          { label: "Steps in this conversation", onSelect: () => set({ bottomOpen: true, bottomTab: "steps" }) },
          { label: "New chat with Pin", onSelect: () => { pin.newChat(); open({ kind: "pin" }); } },
        ]} />
      </div>
      <div className="flex-1 min-h-0 flex flex-col w-full max-w-3xl mx-auto">
        {view.kind === "pin" ? (
          <PinThread inPlace autoFocus className="flex-1" empty={<div className="h-full flex flex-col items-center justify-center text-center gap-3 py-16 px-6"><PinOrb size={44} /><p className="text-ink-2 text-sm max-w-sm text-pretty">Ask Pin about this device, or tell it what to set up. In Agent mode it can act, inside machines too; files and plans it touches open beside the chat.</p></div>}
            below={<div className="px-5 pb-3 -mt-1 flex items-center gap-3 text-xs text-ink-3"><span>{pin.settings?.mode === "agent" ? permission ?? "Agent" : "Assistant"}</span><span className="flex-1" /><span className="truncate">{pin.settings?.model ?? pin.providerName ?? "No model yet"}</span></div>} />
        ) : current && currentAgent ? (
          <AgentChat key={agentKey(current.companyId, current.agentId)} companyId={current.companyId} agent={currentAgent} org={current.org} />
        ) : (
          <div className="p-8"><Notice tone="info">That agent isn't available any more. Pick another conversation.</Notice></div>
        )}
      </div>
    </section>
  );

  const editor = tabs.length > 0 && (
    <div className={cn("bg-bg flex min-h-0", mobilePane === "editor" ? "absolute inset-0 z-(--z-raised) md:static md:inset-auto" : "hidden md:flex")} style={wide() || mobilePane !== "editor" ? { width: layout.editorWidth } : undefined}>
      <ResizeHandle label="Editor width" value={layout.editorWidth} min={320} max={1100} edge="start" onChange={(v) => set({ editorWidth: v })} className="hidden md:block" />
      <div className="flex-1 min-w-0 flex flex-col min-h-0 border-l border-line">
        <div className="md:hidden h-10 shrink-0 flex items-center gap-2 px-2 border-b border-line">
          <BarButton label="Back to the conversation" onClick={() => setMobilePane(null)}><ArrowLeft className="h-4 w-4" /></BarButton>
          <span className="text-compact font-medium">Editors</span>
        </div>
        <EditorGroup tabs={heads} active={active?.id ?? null} onActivate={setActiveTab} onClose={(id) => closeTabs([id])} onKeep={keep} onCloseMany={closeTabs}>
          {editorContent(active)}
        </EditorGroup>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-(--z-workspace) bg-bg flex flex-col" role="region" aria-label="PinView">
      <div className="flex-1 min-h-0 flex">
        <div className="hidden md:flex"><ActivityBar side={layout.side} sideOpen={layout.sideOpen} onSide={showSide} bottomOpen={layout.bottomOpen} onBottom={() => set((l) => ({ bottomOpen: !l.bottomOpen }))} details={layout.details} onDetails={() => set((l) => ({ details: !l.details }))} device={device} unread={unreadCount} /></div>
        {/* The side panel: full width on a phone until a conversation opens. */}
        {(layout.sideOpen || !onMobileThread) && (
          <aside aria-label="Side panel" className={cn("min-h-0 flex-col bg-surface/40 border-r border-line", onMobileThread ? "hidden md:flex" : layout.sideOpen ? "flex w-full md:w-auto" : "flex w-full md:hidden")} style={wide() ? { width: layout.sideWidth } : undefined}>
            <div className="md:hidden flex items-center gap-1 px-2 h-12 border-b border-line">
              <Link to={`/${device}/home`} aria-label="Back to the console" className="h-9 w-9 rounded-lg flex items-center justify-center text-ink-3 hover:text-ink"><ArrowLeft className="h-4 w-4" /></Link>
              {(["chats", "explorer", "artifacts", "prs"] as const).map((v) => <BarButton key={v} label={{ chats: "Conversations", explorer: "Explorer", artifacts: "Artifacts", prs: "Pull requests", search: "" }[v]} pressed={layout.side === v} onClick={() => set({ side: v, sideOpen: true })}>{{ chats: <MessagesSquare className="h-4 w-4" />, explorer: <FolderTree className="h-4 w-4" />, artifacts: <Package className="h-4 w-4" />, prs: <GitPullRequest className="h-4 w-4" />, search: null }[v]}</BarButton>)}
            </div>
            <div className="flex-1 min-h-0">{sideViews[layout.side] ?? sideViews.chats}</div>
          </aside>
        )}
        {layout.sideOpen && <ResizeHandle label="Side panel width" value={layout.sideWidth} min={220} max={520} onChange={(v) => set({ sideWidth: v })} className="hidden md:block" />}

        <div className={cn("relative flex-1 min-w-0 flex-col min-h-0", onMobileThread ? "flex" : "hidden md:flex")}>
          <div className="flex-1 min-h-0 flex relative">
            {conversation}
            {editor}
          </div>
          {layout.bottomOpen && (
            <>
              <ResizeHandle label="Panel height" orientation="horizontal" value={layout.bottomHeight} min={140} max={640} edge="start" onChange={(v) => set({ bottomHeight: v })} className="hidden md:block" />
              <div style={{ height: layout.bottomHeight }} className="shrink-0 min-h-0">
                <BottomPanel tab={layout.bottomTab} onTab={(t) => set({ bottomTab: t })} onClose={() => set({ bottomOpen: false })} messages={view.kind === "pin" ? pin.messages : []} onOpenStep={openStep} />
              </div>
            </>
          )}
        </div>
        {(layout.details || mobilePane === "details") && detailsPanel}
      </div>
      <StatusBar items={[
        { id: "device", label: <><HardDrive className="h-3.5 w-3.5" aria-hidden />{device}</>, title: live ? `Connected to ${device}` : "Demo data" },
        ...(unreadCount ? [{ id: "unread", label: <>{unreadCount} unread</>, title: "Show unread conversations", onClick: () => { setScope("unread"); set({ side: "chats", sideOpen: true }); } }] : []),
        { id: "steps", wideOnly: true, label: <><SquareTerminal className="h-3.5 w-3.5" aria-hidden />{tiles.length ? `${tiles.length} step${tiles.length === 1 ? "" : "s"}` : "Terminal"}</>, title: "Open the panel", onClick: () => set({ bottomOpen: true, bottomTab: tiles.length ? "steps" : "terminal" }) },
        { id: "github", side: "right" as const, wideOnly: true, label: <><GitPullRequest className="h-3.5 w-3.5" aria-hidden />{github.status.data?.connected ? `${(github.prs.data?.prs ?? []).filter((p) => p.state === "open").length} open` : "GitHub"}</>, title: github.status.data?.connected ? "Open pull requests" : "Connect GitHub", tone: (github.prs.data?.prs ?? []).some((p) => p.state === "open" && p.checks === "failure") ? "critical" as const : undefined, onClick: () => (github.status.data?.connected ? openPrs() : set({ side: "prs", sideOpen: true })) },
        { id: "mode", side: "right" as const, label: <>{pin.settings?.mode === "agent" ? `Agent · ${permission ?? ""}` : "Assistant"}</>, title: "Pin's mode and permissions", onClick: () => set({ details: true }) },
        { id: "model", side: "right" as const, wideOnly: true, label: <>{pin.settings?.model ?? pin.providerName ?? "No model"}</>, title: "Pin's model", onClick: () => set({ details: true }) },
      ]} />
      {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}
      {closing && (
        <ConfirmModal title="Close without saving?" label="Close without saving" danger
          body={`${closing.filter((i) => dirty.has(i)).length === 1 ? "A file has" : `${closing.filter((i) => dirty.has(i)).length} files have`} changes that aren't saved to the machine. They will be lost.`}
          onConfirm={() => { const ids_ = closing; setClosing(null); setDirty((d) => new Set([...d].filter((i) => !ids_.includes(i)))); closeTabs(ids_, true); }} onClose={() => setClosing(null)} />
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
