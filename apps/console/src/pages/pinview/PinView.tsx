import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Building2, MessageCircle, PanelRight } from "lucide-react";
import type { Agent } from "@papercliped-engine/engine-client";
import { useAgentsCanRun } from "../containers/Banner.tsx";
import { chatBlock, useSendChat } from "../../data/engine/chat.ts";
import { useChats, useChatsOf, useChatWrites } from "../../data/engine/more.ts";
import { agentStatusOf } from "../../data/engine/labels.tsx";
import { errorText, useAgentContainers, useAgents, useAgentsOf, useComments, useRuns } from "../../data/engine/queries.ts";
import { useEngine } from "../../data/store.tsx";
import { cn } from "../../lib/storage.ts";
import { ConversationList, type ConversationItem } from "../../pin/ConversationList.tsx";
import { PermissionPicker } from "../../pin/PermissionPicker.tsx";
import { usePin } from "../../pin/PinContext.tsx";
import { PinOrb } from "../../pin/PinOrb.tsx";
import { PinThread } from "../../pin/PinThread.tsx";
import { ThreadProvider, type ThreadApi } from "../../pin/ThreadContext.tsx";
import type { ThreadMessage } from "../../pin/useThread.ts";
import { Button, Notice, Select, Status } from "../../ui/primitives.tsx";
import { useNames } from "../org/live/names.ts";

/**
 * PinView: one full-screen place for every conversation on this device. Pin's chats and each organization's agent chats
 * sit in one list (search, filter by who, grouped by day); the one you pick opens beside it with the same thread, cards and
 * composer everywhere. Collaborate rooms join the list later.
 */

type View = { kind: "pin" } | { kind: "agent"; companyId: string; agentId: string };
const agentKey = (companyId: string, agentId: string) => `agent:${companyId}:${agentId}`;

export function PinView() {
  const { data, setup, live } = useEngine();
  const pin = usePin();
  const device = setup?.deviceName ?? "pve";
  const [params, setParams] = useSearchParams();
  const [details, setDetails] = useState(false);
  const orgs = data.orgs.flatMap((o) => (o.engine ? [{ name: o.name, slug: o.slug, hue: o.hue, companyId: o.engine.companyId }] : []));
  const ids = orgs.map((o) => o.companyId);
  const agents = useAgentsOf(ids);
  const chats = useChatsOf(ids);

  const view: View = useMemo(() => {
    const [kind, companyId, agentId] = (params.get("c") ?? "").split(":");
    return kind === "agent" && companyId && agentId ? { kind: "agent", companyId, agentId } : { kind: "pin" };
  }, [params]);
  /** Opens a conversation; `t` is what a phone uses to show the thread instead of the list. */
  const open = (v: View) => setParams((p) => { const n = new URLSearchParams(p); if (v.kind === "pin") n.delete("c"); else n.set("c", `agent:${v.companyId}:${v.agentId}`); n.set("t", "1"); return n; }, { replace: true });
  const toList = () => setParams((p) => { const n = new URLSearchParams(p); n.delete("t"); return n; }, { replace: true });

  const agentName = (companyId: string, agentId: string) => agents[ids.indexOf(companyId)]?.data?.find((a) => a.id === agentId)?.name ?? "Agent";
  const items: ConversationItem[] = useMemo(() => {
    const out: ConversationItem[] = pin.chats.map((c) => ({ key: `pin:${c.id}`, source: "pin", title: c.title, context: "Pin", updatedAt: new Date(c.updatedAt).getTime() }));
    chats.forEach((q, i) => {
      const org = orgs[i];
      if (!org) return;
      for (const c of q.data ?? []) {
        if (!c.conversationAgentId) continue;
        out.push({ key: agentKey(org.companyId, c.conversationAgentId), source: "agent", title: agentName(org.companyId, c.conversationAgentId), context: org.name, updatedAt: new Date(c.updatedAt).getTime() });
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin.chats, chats.map((q) => q.dataUpdatedAt).join(), agents.map((q) => q.dataUpdatedAt).join(), ids.join()]);

  const allAgents = orgs.flatMap((o, i) => (agents[i]?.data ?? []).filter((a) => a.status !== "terminated").map((a) => ({ companyId: o.companyId, org: o.name, agent: a })));
  const activeKey = view.kind === "agent" ? agentKey(view.companyId, view.agentId) : pin.chatId ? `pin:${pin.chatId}` : null;
  const current = view.kind === "agent" ? allAgents.find((a) => a.companyId === view.companyId && a.agent.id === view.agentId) : null;

  return (
    <div className="fixed inset-0 z-(--z-fullscreen) bg-bg flex" role="region" aria-label="PinView">
      <aside className={cn("w-full md:w-80 shrink-0 border-r border-line bg-surface/40 flex flex-col min-h-0 p-3", params.get("t") ? "hidden md:flex" : "flex")}>
        <div className="flex items-center gap-2 mb-3">
          <Link to={`/${device}/home`} aria-label="Back to the console" className="transition-control h-9 w-9 rounded-lg text-ink-3 hover:text-ink hover:bg-surface-2 flex items-center justify-center"><ArrowLeft className="h-4 w-4" /></Link>
          <h1 className="text-sm font-semibold flex-1">PinView</h1>
        </div>
        {live && allAgents.length > 0 && (
          <Select aria-label="Chat with an agent" size="sm" className="mb-2" value="" onChange={(e) => { const [c, a] = e.target.value.split("|"); if (c && a) open({ kind: "agent", companyId: c, agentId: a }); }}>
            <option value="">Chat with an agent…</option>
            {allAgents.map((a) => <option key={`${a.companyId}|${a.agent.id}`} value={`${a.companyId}|${a.agent.id}`}>{a.org} · {a.agent.name}</option>)}
          </Select>
        )}
        <ConversationList
          className="flex-1"
          label="Conversations"
          items={items}
          activeKey={activeKey}
          search
          filter
          grouped
          empty={live ? "Your chats with Pin and with your agents are kept here." : "Chats are kept on a device. The demo doesn't save them."}
          onNew={() => { pin.newChat(); open({ kind: "pin" }); }}
          onPick={(c) => {
            if (c.source === "pin") { void pin.openChat(c.key.slice(4)); open({ kind: "pin" }); }
            else { const [, companyId, agentId] = c.key.split(":"); open({ kind: "agent", companyId: companyId!, agentId: agentId! }); }
          }}
          onRename={(c, title) => (c.source === "pin" ? pin.renameChat(c.key.slice(4), title) : Promise.reject(new Error("Agent chats are named after the agent.")))}
          onDelete={(c) => (c.source === "pin" ? pin.deleteChat(c.key.slice(4)) : Promise.reject(new Error("An agent chat lives in its organization; delete its task there.")))}
        />
      </aside>

      <main className={cn("flex-1 min-w-0 flex-col min-h-0", params.get("t") ? "flex" : "hidden md:flex")}>
        <div className="h-12 shrink-0 border-b border-line flex items-center gap-2 px-3">
          <button type="button" onClick={toList} aria-label="Back to conversations" className="md:hidden h-9 w-9 rounded-lg text-ink-3 hover:text-ink hover:bg-surface-2 flex items-center justify-center"><ArrowLeft className="h-4 w-4" /></button>
          {view.kind === "pin" ? <PinOrb size={22} /> : <MessageCircle className="h-4 w-4 text-ink-3" aria-hidden />}
          <div className="text-sm font-medium truncate flex-1">{view.kind === "pin" ? "Pin" : current?.agent.name ?? "Agent"}{current && <span className="text-ink-3 font-normal"> · {current.org}</span>}</div>
          <button type="button" aria-label="Details" aria-pressed={details} onClick={() => setDetails((v) => !v)} className={cn("transition-control h-9 w-9 rounded-lg flex items-center justify-center hover:bg-surface-2", details ? "text-ink bg-surface-2" : "text-ink-3")}><PanelRight className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 flex flex-col min-h-0 max-w-4xl mx-auto w-full">
            {view.kind === "pin" ? (
              <PinThread inPlace autoFocus className="flex-1" empty={<div className="h-full flex flex-col items-center justify-center text-center gap-3 py-16"><PinOrb size={44} /><p className="text-ink-2 text-sm max-w-sm text-pretty">Ask Pin about this device, or tell it what to set up. Switch to Agent mode to let it act.</p></div>} />
            ) : current ? (
              <AgentChat key={agentKey(current.companyId, current.agent.id)} companyId={current.companyId} agent={current.agent} />
            ) : (
              <div className="p-8"><Notice tone="info">That agent isn't available any more. Pick another conversation.</Notice></div>
            )}
          </div>
          {details && (
            <aside aria-label="Details" className="hidden lg:block w-72 shrink-0 border-l border-line p-4 space-y-4 overflow-y-auto">
              {view.kind === "pin" ? (
                <>
                  <div><div className="text-xs text-ink-3">Model</div><div className="text-sm">{pin.providerName ?? "Not set up"}{pin.settings?.model ? <span className="text-ink-3"> · {pin.settings.model}</span> : null}</div></div>
                  <div><div className="text-xs text-ink-3 mb-1">Mode</div><div className="text-sm">{pin.settings?.mode === "agent" ? "Agent" : "Assistant"}</div></div>
                  <PermissionPicker />
                </>
              ) : current ? (
                <>
                  <div><div className="text-xs text-ink-3">Organization</div><div className="text-sm flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5 text-ink-3" aria-hidden />{current.org}</div></div>
                  <div><div className="text-xs text-ink-3 mb-1">Agent</div><Status kind={agentStatusOf(current.agent.status)[0]} label={agentStatusOf(current.agent.status)[1]} /></div>
                  <Link to={`/${device}/${orgs.find((o) => o.companyId === current.companyId)?.slug ?? ""}/agents/${current.agent.id}`} className="text-compact text-accent hover:underline">Open the agent</Link>
                </>
              ) : null}
            </aside>
          )}
        </div>
      </main>
    </div>
  );
}

/** An organization's chat with one agent, drawn by the same thread as Pin's: each comment on the conversation task is a message. */
function AgentChat({ companyId, agent }: { companyId: string; agent: Agent }) {
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
        footer={(block || error) ? (
          <div className="px-4 space-y-2">
            {block && <Notice tone="warning" title={block.reason}>{block.todo}</Notice>}
            {error && <p role="alert" className="text-compact text-critical">{error}</p>}
          </div>
        ) : undefined} />
    </ThreadProvider>
  );
}
