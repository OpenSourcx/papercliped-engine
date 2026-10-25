import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Building2, ChevronDown, ChevronRight, FolderOpen, GitPullRequest, Layers, MessageCircle, MessageSquarePlus, MoreHorizontal, PanelRight, Settings, X } from "lucide-react";
import type { Agent } from "@papercliped-engine/engine-client";
import { useAgentsCanRun } from "../containers/Banner.tsx";
import { chatBlock, useSendChat } from "../../data/engine/chat.ts";
import { githubApi } from "../../data/engine/githubApi.ts";
import { useChats, useChatsOf, useChatWrites } from "../../data/engine/more.ts";
import { agentStatusOf } from "../../data/engine/labels.tsx";
import { errorText, useAgentContainers, useAgentsOf, useComments, useConnectors, useRuns } from "../../data/engine/queries.ts";
import { useEngine } from "../../data/store.tsx";
import { cn, readJson, writeJson } from "../../lib/storage.ts";
import { settingsHref } from "../../modals/useModals.ts";
import { ConversationList, type ConversationItem, type ConversationSection } from "../../pin/ConversationList.tsx";
import { PERMISSION_INFO, PermissionPicker } from "../../pin/PermissionPicker.tsx";
import { usePin } from "../../pin/PinContext.tsx";
import { PinOrb } from "../../pin/PinOrb.tsx";
import { PinThread } from "../../pin/PinThread.tsx";
import { ThreadProvider, type ThreadApi } from "../../pin/ThreadContext.tsx";
import type { ThreadMessage } from "../../pin/useThread.ts";
import { Avatar, Menu, Notice, Select, Status, type MenuEntry } from "../../ui/primitives.tsx";
import { useNames } from "../org/live/names.ts";
import { ChangesBody, PullRequestList, useGithub } from "./Changes.tsx";
import { FilesPanel } from "./FilesPanel.tsx";
import { Pane, TileView } from "./TileView.tsx";
import { tilesOf } from "./tiles.ts";
import { useQueryClient } from "@tanstack/react-query";

/**
 * PinView: one full-screen workspace for every conversation on this device, laid out like a desktop chat app.
 *
 * - Left, the sidebar: New chat, Files, a search box, your pinned chats, then Pin's chats and each organization's agent
 *   chats in folding sections; each row has a menu (pin, rename, copy link, delete). Your name and Settings at the bottom.
 * - Middle, the conversation in a centered column, with what it runs on under the composer; each message has a menu
 *   (copy, copy as Markdown, quote in reply).
 * - Right, tiles that open by themselves when the assistant works: a file it read or wrote, a command's output, a plan.
 *   Files and Pull requests open there too. Each tile has its own menu (word wrap, line numbers, copy), expand and close.
 * - Far right, the details: folding cards (Model, Permissions, Connectors, Changes for Pin; Agent, Organization, Files,
 *   Changes for an agent), with a Show menu to choose which cards appear.
 *
 * On a phone each part is a pane of its own. Collaborate rooms join the sidebar later.
 */

type View = { kind: "pin" } | { kind: "agent"; companyId: string; agentId: string };
type Extra = "files" | "prs";
const agentKey = (companyId: string, agentId: string) => `agent:${companyId}:${agentId}`;
const PINNED = "epc.pinview.pinned";
const HIDDEN = "epc.pinview.hidden";
const MAX_TILES = 3;

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
const wide = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1024px)").matches;

export function PinView() {
  const { data, setup, live } = useEngine();
  const pin = usePin();
  const qc = useQueryClient();
  const connectors = useConnectors();
  const github = useGithub();
  const device = setup?.deviceName ?? "pve";
  const [params, setParams] = useSearchParams();
  const [details, setDetails] = useState(false);
  const [tilesOpen, setTilesOpen] = useState(false);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [allTiles, setAllTiles] = useState(false);
  const [editingGithub, setEditingGithub] = useState(false);
  const [filesOrg, setFilesOrg] = useState<string | null>(null);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set(readJson<string[]>(PINNED, [])));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set(readJson<string[]>(HIDDEN, [])));
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
  /** Opens a conversation; `t` is what a phone uses to show the thread instead of the list. */
  const open = (v: View) => setParams((p) => { const n = new URLSearchParams(p); n.delete("chat"); if (v.kind === "pin") n.delete("c"); else n.set("c", `agent:${v.companyId}:${v.agentId}`); n.set("t", "1"); return n; }, { replace: true });
  const toList = () => setParams((p) => { const n = new URLSearchParams(p); n.delete("t"); return n; }, { replace: true });

  // A copied link to one of Pin's chats (?chat=<id>) opens it.
  const linked = params.get("chat");
  useEffect(() => {
    if (linked && linked !== pin.chatId) void pin.openChat(linked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked]);

  const agentName = (companyId: string, agentId: string) => agents[ids.indexOf(companyId)]?.data?.find((a) => a.id === agentId)?.name ?? "Agent";
  const sections: ConversationSection[] = useMemo(() => {
    const pinItems = pin.chats.map((c): ConversationItem => ({ key: `pin:${c.id}`, source: "pin", title: c.title, context: "Pin", updatedAt: new Date(c.updatedAt).getTime() }));
    const byOrg = orgs.map((org, i) => ({ org, items: (chats[i]?.data ?? []).flatMap((c): ConversationItem[] => (c.conversationAgentId ? [{ key: agentKey(org.companyId, c.conversationAgentId), source: "agent", title: agentName(org.companyId, c.conversationAgentId), context: org.name, updatedAt: new Date(c.updatedAt).getTime() }] : [])) }));
    const everything = [...pinItems, ...byOrg.flatMap((o) => o.items)];
    const star = everything.filter((c) => pinned.has(c.key));
    const rest = (xs: ConversationItem[]) => xs.filter((c) => !pinned.has(c.key));
    return [
      ...(star.length ? [{ id: "pinned", label: "Pinned", items: star }] : []),
      { id: "pin", label: "Pin", icon: <PinOrb size={14} />, items: rest(pinItems) },
      ...byOrg.map((o) => ({ id: o.org.companyId, label: o.org.name, icon: <Building2 className="h-3.5 w-3.5" aria-hidden />, items: rest(o.items) })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin.chats, pinned, chats.map((q) => q.dataUpdatedAt).join(), agents.map((q) => q.dataUpdatedAt).join(), ids.join()]);

  const allAgents = orgs.flatMap((o, i) => (agents[i]?.data ?? []).filter((a) => a.status !== "terminated").map((a) => ({ companyId: o.companyId, org: o.name, agent: a })));
  const activeKey = view.kind === "agent" ? agentKey(view.companyId, view.agentId) : pin.chatId ? `pin:${pin.chatId}` : null;
  const current = view.kind === "agent" ? allAgents.find((a) => a.companyId === view.companyId && a.agent.id === view.agentId) : null;
  const orgOfCurrent = current ? orgs.find((o) => o.companyId === current.companyId) : null;
  const permission = PERMISSION_INFO.find((p) => p.id === pin.settings?.permission)?.label;
  const title = view.kind === "pin" ? (pin.chats.find((c) => c.id === pin.chatId)?.title ?? "New chat") : current?.agent.name ?? "Agent";
  const configured = (connectors.data?.connectors ?? []).filter((c) => c.configured);
  const iconBtn = (on: boolean) => cn("transition-control relative h-9 w-9 rounded-lg flex items-center justify-center hover:bg-surface-2", on ? "text-ink bg-surface-2" : "text-ink-3");
  const linkFor = (c: ConversationItem) => `${window.location.origin}/${device}/view?${c.source === "pin" ? `chat=${encodeURIComponent(c.key.slice(4))}` : `c=${encodeURIComponent(c.key)}`}`;

  // Tiles come from the open conversation's tool steps (Pin's thread; agent chats have none yet). A new one opens the
  // column by itself on a wide screen; on a phone it waits for the Tiles button so the conversation stays in view.
  const tiles = useMemo(() => (view.kind === "pin" ? tilesOf(pin.messages, closed) : []), [view.kind, pin.messages, closed]);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const fresh = tiles.filter((t) => !seen.current.has(t.id));
    tiles.forEach((t) => seen.current.add(t.id));
    if (fresh.length && wide()) setTilesOpen(true);
  }, [tiles]);
  const shownTiles = allTiles ? tiles : tiles.slice(-MAX_TILES);
  const openExtra = (x: Extra) => { setExtras((xs) => (xs.includes(x) ? xs : [x, ...xs])); setTilesOpen(true); };
  const closeExtra = (x: Extra) => setExtras((xs) => xs.filter((y) => y !== x));
  const paneCount = extras.length + tiles.length;
  const column = tilesOpen && paneCount > 0;

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
      { label: "Show all pull requests", onSelect: () => openExtra("prs") },
      { label: "Refresh", onSelect: () => void qc.invalidateQueries({ queryKey: ["github", "prs"] }) },
      { label: "Change token or repositories", onSelect: () => setEditingGithub(true) },
      { kind: "separator" },
      { label: "Disconnect GitHub", danger: true, onSelect: () => void githubApi.disconnect().then((s) => { qc.setQueryData(["github", "status"], s); closeExtra("prs"); }) },
    ]} />
  ) : undefined;
  const changesCard = visible("changes") && (
    <DetailCard title="Changes" action={changesAction}>
      <ChangesBody onShowAll={() => openExtra("prs")} editing={editingGithub} onEdited={() => setEditingGithub(false)} />
    </DetailCard>
  );

  return (
    <div className="fixed inset-0 z-(--z-fullscreen) bg-bg flex" role="region" aria-label="PinView">
      <aside className={cn("w-full md:w-72 shrink-0 border-r border-line bg-surface/40 flex-col min-h-0 p-3", params.get("t") ? "hidden md:flex" : "flex")}>
        <div className="flex items-center gap-2 mb-3">
          <Link to={`/${device}/home`} aria-label="Back to the console" className="transition-control h-9 w-9 rounded-lg text-ink-3 hover:text-ink hover:bg-surface-2 flex items-center justify-center"><ArrowLeft className="h-4 w-4" /></Link>
          <h1 className="text-sm font-semibold flex-1">PinView</h1>
        </div>
        <button type="button" onClick={() => { pin.newChat(); open({ kind: "pin" }); }} className="transition-control flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-compact hover:bg-surface-2"><MessageSquarePlus className="h-4 w-4 text-ink-2" aria-hidden />New chat</button>
        <button type="button" onClick={() => { openExtra("files"); setParams((p) => { const n = new URLSearchParams(p); n.set("t", "1"); return n; }, { replace: true }); }} className="transition-control flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-compact hover:bg-surface-2"><FolderOpen className="h-4 w-4 text-ink-2" aria-hidden />Files</button>
        <button type="button" onClick={() => { openExtra("prs"); setParams((p) => { const n = new URLSearchParams(p); n.set("t", "1"); return n; }, { replace: true }); }} className="transition-control flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-compact hover:bg-surface-2 mb-2"><GitPullRequest className="h-4 w-4 text-ink-2" aria-hidden />Pull requests</button>
        {live && allAgents.length > 0 && (
          <Select aria-label="Chat with an agent" size="sm" className="mb-2" value="" onChange={(e) => { const [c, a] = e.target.value.split("|"); if (c && a) open({ kind: "agent", companyId: c, agentId: a }); }}>
            <option value="">Chat with an agent…</option>
            {allAgents.map((a) => <option key={`${a.companyId}|${a.agent.id}`} value={`${a.companyId}|${a.agent.id}`}>{a.org} · {a.agent.name}</option>)}
          </Select>
        )}
        <ConversationList
          className="flex-1"
          label="Conversations"
          sections={sections}
          activeKey={activeKey}
          search
          pinned={pinned}
          onTogglePin={togglePin}
          linkFor={linkFor}
          empty={live ? "Your chats with Pin and with your agents are kept here." : "Chats are kept on a device. The demo doesn't save them."}
          onPick={(c) => {
            if (c.source === "pin") { void pin.openChat(c.key.slice(4)); open({ kind: "pin" }); }
            else { const [, companyId, agentId] = c.key.split(":"); open({ kind: "agent", companyId: companyId!, agentId: agentId! }); }
          }}
          onRename={(c, t) => (c.source === "pin" ? pin.renameChat(c.key.slice(4), t) : Promise.reject(new Error("Agent chats are named after the agent.")))}
          onDelete={(c) => (c.source === "pin" ? pin.deleteChat(c.key.slice(4)) : Promise.reject(new Error("An agent chat lives in its organization; delete its task there.")))}
        />
        <Link to={settingsHref("general")} className="transition-control mt-2 flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-surface-2">
          <Avatar name={setup?.ownerName || "You"} hue={32} size={28} />
          <span className="text-compact truncate flex-1">{setup?.ownerName || "You"}</span>
          <Settings className="h-4 w-4 text-ink-3" aria-hidden /><span className="sr-only">Settings</span>
        </Link>
      </aside>

      <main className={cn("relative flex-1 min-w-0 flex-col min-h-0", params.get("t") ? "flex" : "hidden md:flex")}>
        <div className="h-12 shrink-0 border-b border-line flex items-center gap-1 px-3">
          <button type="button" onClick={toList} aria-label="Back to conversations" className="md:hidden h-9 w-9 rounded-lg text-ink-3 hover:text-ink hover:bg-surface-2 flex items-center justify-center"><ArrowLeft className="h-4 w-4" /></button>
          <span className="mr-1">{view.kind === "pin" ? <PinOrb size={20} /> : <MessageCircle className="h-4 w-4 text-ink-3" aria-hidden />}</span>
          <div className="text-sm font-medium truncate flex-1 min-w-0">{title}{orgOfCurrent && <span className="text-ink-3 font-normal"> · {orgOfCurrent.name}</span>}</div>
          <button type="button" aria-label="Files" aria-pressed={extras.includes("files") && tilesOpen} onClick={() => (extras.includes("files") && tilesOpen ? closeExtra("files") : openExtra("files"))} className={iconBtn(extras.includes("files") && tilesOpen)}><FolderOpen className="h-4 w-4" /></button>
          <button type="button" aria-label={`Tiles${tiles.length ? ` (${tiles.length})` : ""}`} aria-pressed={column} disabled={paneCount === 0} onClick={() => setTilesOpen((v) => !v)} className={cn(iconBtn(column), "disabled:opacity-40")}>
            <Layers className="h-4 w-4" />{tiles.length > 0 && !column && <span aria-hidden className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-accent text-on-status text-micro font-bold flex items-center justify-center">{tiles.length}</span>}
          </button>
          <button type="button" aria-label="Details" aria-pressed={details} onClick={() => setDetails((v) => !v)} className={iconBtn(details)}><PanelRight className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            <div className="flex-1 min-h-0 flex flex-col max-w-3xl mx-auto w-full">
              {view.kind === "pin" ? (
                <PinThread inPlace autoFocus className="flex-1" empty={<div className="h-full flex flex-col items-center justify-center text-center gap-3 py-16"><PinOrb size={44} /><p className="text-ink-2 text-sm max-w-sm text-pretty">Ask Pin about this device, or tell it what to set up. Switch to Agent mode to let it act.</p></div>}
                  below={<div className="px-5 pb-3 -mt-1 flex items-center gap-3 text-xs text-ink-3"><span>{pin.settings?.mode === "agent" ? permission ?? "Agent" : "Assistant"}</span><span className="flex-1" /><span className="truncate">{pin.settings?.model ?? pin.providerName ?? "No model yet"}</span></div>} />
              ) : current ? (
                <AgentChat key={agentKey(current.companyId, current.agent.id)} companyId={current.companyId} agent={current.agent} org={current.org} />
              ) : (
                <div className="p-8"><Notice tone="info">That agent isn't available any more. Pick another conversation.</Notice></div>
              )}
            </div>
          </div>

          {column && (
            <aside aria-label="Tiles" className="absolute inset-0 lg:static lg:inset-auto bg-bg lg:w-96 xl:w-120 shrink-0 lg:border-l border-line flex flex-col min-h-0">
              <div className="h-12 shrink-0 border-b border-line flex items-center gap-2 pl-4 pr-2 lg:hidden">
                <span className="text-sm font-medium flex-1">Tiles</span>
                <button type="button" aria-label="Close tiles" onClick={() => setTilesOpen(false)} className="transition-control h-9 w-9 rounded-lg text-ink-3 hover:text-ink hover:bg-surface-2 flex items-center justify-center"><X className="h-4 w-4" /></button>
              </div>
              <div className="flex-1 min-h-0 flex flex-col gap-3 p-3 overflow-y-auto">
                {extras.filter((x) => !expanded || expanded === x).map((x) => x === "files" ? (
                  <Pane key="files" icon={<FolderOpen className="h-4 w-4" />} title="Files" sub="What agents produced" expanded={expanded === "files"} onExpand={() => setExpanded((e) => (e === "files" ? null : "files"))} onClose={() => closeExtra("files")} className={cn("shrink-0", expanded === "files" ? "flex-1" : "h-96")}>
                    <div className="p-3"><FilesPanel orgs={orgs} companyId={view.kind === "agent" ? view.companyId : filesOrg ?? orgs[0]?.companyId ?? null} onOrg={setFilesOrg} /></div>
                  </Pane>
                ) : (
                  <Pane key="prs" icon={<GitPullRequest className="h-4 w-4" />} title="Pull requests" sub={github.status.data?.connected ? github.status.data.repos.join(", ") : "GitHub isn't connected"} expanded={expanded === "prs"} onExpand={() => setExpanded((e) => (e === "prs" ? null : "prs"))} onClose={() => closeExtra("prs")} className={cn("shrink-0", expanded === "prs" ? "flex-1" : "h-96")}
                    menu={github.status.data?.connected ? [{ label: "Refresh", onSelect: () => void qc.invalidateQueries({ queryKey: ["github", "prs"] }) }] : undefined}>
                    <div className="p-3 space-y-3">{github.status.data?.connected ? <PullRequestList prs={github.prs.data?.prs ?? []} /> : <ChangesBody onShowAll={() => undefined} editing={false} onEdited={() => undefined} />}</div>
                  </Pane>
                ))}
                {tiles.length > MAX_TILES && !expanded && (
                  <button type="button" onClick={() => setAllTiles((v) => !v)} className="text-compact text-accent hover:underline self-start">{allTiles ? "Show only the newest" : `Show ${tiles.length - MAX_TILES} earlier`}</button>
                )}
                {shownTiles.filter((t) => !expanded || expanded === t.id).map((t) => (
                  <div key={t.id} className={cn("flex flex-col min-h-0 shrink-0", expanded === t.id ? "flex-1" : "h-96")}>
                    <TileView tile={t} device={device} expanded={expanded === t.id} onExpand={() => setExpanded((e) => (e === t.id ? null : t.id))} onClose={() => { setClosed((c) => new Set([...c, t.id])); if (expanded === t.id) setExpanded(null); }} />
                  </div>
                ))}
              </div>
            </aside>
          )}

          {details && (
            <aside aria-label="Details" className="absolute inset-0 lg:static lg:inset-auto bg-bg lg:w-80 shrink-0 lg:border-l border-line flex flex-col min-h-0">
              <div className="h-12 shrink-0 border-b border-line flex items-center gap-1 pl-4 pr-2">
                <span className="text-sm font-medium flex-1">Details</span>
                <Menu label="Show cards" icon={<MoreHorizontal className="h-4 w-4" />} items={showMenu} />
                <button type="button" aria-label="Close details" onClick={() => setDetails(false)} className="transition-control h-9 w-9 rounded-lg text-ink-3 hover:text-ink hover:bg-surface-2 flex items-center justify-center"><X className="h-4 w-4" /></button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
                {view.kind === "pin" ? (
                  <>
                    {visible("model") && (
                      <DetailCard title="Model">
                        <Fact label="Provider">{pin.providerName ?? "Not set up"}</Fact>
                        <Fact label="Model">{pin.settings?.model ?? "None chosen"}</Fact>
                        <Link to={`/${device}/pin?tab=settings`} className="text-compact text-accent hover:underline">Change in Pin's settings</Link>
                      </DetailCard>
                    )}
                    {visible("permissions") && (
                      <DetailCard title="Permissions">
                        <Fact label="Mode">{pin.settings?.mode === "agent" ? "Agent" : "Assistant"}</Fact>
                        <PermissionPicker />
                      </DetailCard>
                    )}
                    {visible("connectors") && (
                      <DetailCard title="Connectors" open={configured.length > 0}>
                        {configured.length === 0 ? <p className="text-compact text-ink-3">No connectors are set up yet.</p> : (
                          <ul className="space-y-1.5">{configured.map((c) => <li key={c.id} className="flex items-center gap-2 text-compact"><span className="flex-1 truncate">{c.label ?? c.id}</span><Status kind={pin.settings?.connectors.includes(c.id) ? "good" : "idle"} label={pin.settings?.connectors.includes(c.id) ? "Pin uses it" : "Not used"} /></li>)}</ul>
                        )}
                        <Link to={settingsHref("connectors")} className="text-compact text-accent hover:underline">Manage connectors</Link>
                      </DetailCard>
                    )}
                    {changesCard}
                  </>
                ) : current ? (
                  <>
                    {visible("agent") && (
                      <DetailCard title="Agent">
                        <Fact label="Name">{current.agent.name}</Fact>
                        <div><div className="text-xs text-ink-3 mb-1">Status</div><Status kind={agentStatusOf(current.agent.status)[0]} label={agentStatusOf(current.agent.status)[1]} /></div>
                        <Link to={`/${device}/${orgOfCurrent?.slug ?? ""}/agents/${current.agent.id}`} className="text-compact text-accent hover:underline">Open the agent</Link>
                      </DetailCard>
                    )}
                    {visible("organization") && (
                      <DetailCard title="Organization">
                        <Fact label="Name"><span className="inline-flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5 text-ink-3" aria-hidden />{current.org}</span></Fact>
                        <Link to={`/${device}/${orgOfCurrent?.slug ?? ""}`} className="text-compact text-accent hover:underline">Open the organization</Link>
                      </DetailCard>
                    )}
                    {visible("files") && (
                      <DetailCard title="Files">
                        <p className="text-compact text-ink-3 text-pretty">Documents and files this organization's agents produced.</p>
                        <button type="button" onClick={() => openExtra("files")} className="text-compact text-accent hover:underline">Browse files</button>
                      </DetailCard>
                    )}
                    {changesCard}
                  </>
                ) : null}
                {cardsFor.every((c) => hidden.has(c.id)) && <p className="text-compact text-ink-3 px-1">Every card is hidden. Choose some from the menu above.</p>}
              </div>
            </aside>
          )}
        </div>
      </main>
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
