import { useEffect, useRef, useState } from "react";
import { MessageCircle, Send } from "lucide-react";
import type { Agent } from "@papercliped-engine/engine-client";
import { Link } from "react-router-dom";
import { useAgentsCanRun } from "../../containers/Banner.tsx";
import { chatBlock, chatDisabled, useSendChat, type ChatBlock } from "../../../data/engine/chat.ts";
import { ago } from "../../../data/engine/map.ts";
import { agentStatusOf } from "../../../data/engine/labels.tsx";
import { useAgentAction, useAgentContainers, useAgents, useComments, useMe, useRuns } from "../../../data/engine/queries.ts";
import { useEngine } from "../../../data/store.tsx";
import { settingsHref } from "../../../modals/useModals.ts";
import { useChats, useChatWrites } from "../../../data/engine/more.ts";
import { Avatar, Button, Card, EmptyState, Notice, PageFrame, PageHeader, Spinner, Status, Textarea } from "../../../ui/primitives.tsx";
import { ActionError, LoadError, Loading, useLiveOrg } from "./common.tsx";
import { useNames } from "./names.ts";

/** Chat with one agent. A conversation is a task the engine keeps for you and that agent; each message is a comment on it. */
export function LiveChat() {
  const { companyId, org } = useLiveOrg();
  const me = useMe();
  const agents = useAgents(companyId);
  const chats = useChats(companyId, true);
  const w = useChatWrites(companyId);
  const [selected, setSelected] = useState<string | null>(null);
  const disabled = chatDisabled(chats.error);
  const canRun = useAgentsCanRun();
  const list = (agents.data ?? []).filter((a) => a.status !== "terminated");
  const byAgent = new Map((chats.data ?? []).map((c) => [c.conversationAgentId, c]));
  const current = list.find((a) => a.id === selected) ?? null;
  const conv = current ? byAgent.get(current.id) ?? null : null;

  if (disabled) {
    return (
      <PageFrame width="3xl">
        <PageHeader title="Chat" subtitle="Talk with your agents in threads." />
        <Card className="p-6">
          <EmptyState icon={<MessageCircle className="h-5 w-5" />} title="Chat is switched off" body="Agent chat is an experimental setting of the engine, so it's off until an administrator turns it on." action={me.data?.isInstanceAdmin ? <Button variant="primary" loading={w.enable.isPending} onClick={() => w.enable.mutate(undefined, { onSuccess: () => void chats.refetch() })}>Turn on chat</Button> : <span className="text-compact text-ink-3">Ask a Proxmox administrator to turn it on.</span>} />
          <ActionError error={w.enable.error} />
        </Card>
      </PageFrame>
    );
  }

  return (
    <PageFrame width="6xl">
      <PageHeader title="Chat" subtitle={`Ask ${org.name}'s agents questions or give them work. Replies arrive here as they write them.`} />
      <div className="grid md:grid-cols-[16rem_1fr] gap-4">
        <Card className="divide-y divide-line h-fit">
          {(agents.isPending || chats.isPending) && <Loading />}
          {chats.error && <LoadError error={chats.error} retry={() => void chats.refetch()} />}
          {agents.data && list.length === 0 && <p className="px-4 py-4 text-sm text-ink-3">Create an agent to chat with.</p>}
          {list.map((a) => {
            const c = byAgent.get(a.id);
            return (
              <button key={a.id} onClick={() => setSelected(a.id)} aria-current={a.id === selected ? "true" : undefined} className={`w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-surface-2/40 ${a.id === selected ? "bg-surface-3" : ""}`}>
                <Avatar name={a.name} hue={org.hue + 40} size={32} />
                <span className="flex-1 min-w-0"><span className="block text-sm font-medium truncate">{a.name}</span><span className="block text-xs text-ink-3">{c ? `Updated ${ago(c.updatedAt)}` : "Start a chat"}</span></span>
                {c?.conversationState === "active" && canRun && a.status !== "error" && a.status !== "paused" && a.status !== "pending_approval" && <Spinner label="Writing" className="[&>span]:sr-only" />}
              </button>
            );
          })}
        </Card>
        {current ? <Thread key={current.id} agent={current} conversationId={conv?.id ?? null} startedAt={conv?.createdAt ?? null} working={conv?.conversationState === "active"} /> : (
          <Card><EmptyState icon={<MessageCircle className="h-5 w-5" />} title="Pick an agent" body="Choose someone on the left to open a chat. New chats start when you send the first message." /></Card>
        )}
      </div>
    </PageFrame>
  );
}

function Thread({ agent, conversationId, startedAt, working }: { agent: Agent; conversationId: string | null; startedAt: string | Date | null; working: boolean }) {
  const { companyId, org } = useLiveOrg();
  const names = useNames(companyId);
  const w = useChatWrites(companyId);
  const comments = useComments(conversationId ? companyId : null, conversationId ?? "");
  const send = useSendChat(companyId);
  const [text, setText] = useState("");
  const [error, setError] = useState<unknown>(null);
  const end = useRef<HTMLDivElement>(null);
  const messages = conversationId ? comments.data ?? [] : [];
  const [kind, label] = agentStatusOf(agent.status);
  const containers = useAgentContainers();
  const runs = useRuns(conversationId ? companyId : null, agent.id);
  const act = useAgentAction(companyId);
  const { setup } = useEngine();
  const block: ChatBlock | null = chatBlock({
    agent,
    run: runs.data?.[0] ?? null,
    conversationStartedAt: startedAt,
    containersReady: containers.data ? containers.data.state === "ready" : undefined,
    canManageContainers: containers.data?.canManage,
  });
  const writing = working && !block;
  useEffect(() => end.current?.scrollIntoView?.({ block: "end" }), [messages.length, writing, block?.code]);
  const base = `/${setup?.deviceName ?? "pve"}/${org.slug}`;
  const [checking, setChecking] = useState(false);
  const retrying = act.isPending || checking;
  /** Looks again, and once nothing blocks the agent any more, wakes it so it reads the thread. */
  const retry = async () => {
    setChecking(true);
    try {
      const [c] = await Promise.all([containers.refetch(), runs.refetch()]);
      const still = chatBlock({ agent, run: null, containersReady: c.data ? c.data.state === "ready" : undefined, canManageContainers: c.data?.canManage });
      if (!still) act.mutate({ id: agent.id, action: "wakeup" });
    } finally {
      setChecking(false);
    }
  };

  const submit = async () => {
    const body = text.trim();
    if (!body) return;
    setError(null);
    try {
      // The conversation is created the first time you write, as the engine intends.
      let id = conversationId;
      if (!id) id = (await w.open.mutateAsync(agent.id)).id;
      await send.mutateAsync({ issueId: id, body });
      setText("");
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Card className="flex flex-col min-h-[28rem]">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-line"><Avatar name={agent.name} hue={org.hue + 40} size={32} /><div className="flex-1"><div className="text-sm font-medium">{agent.name}</div></div><Status kind={kind} label={label} /></div>
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 max-h-[60vh]" aria-live="polite" aria-label={`Conversation with ${agent.name}`}>
        {conversationId && comments.isPending && <Loading />}
        {comments.error && <LoadError error={comments.error} retry={() => void comments.refetch()} />}
        {!conversationId && <p className="text-sm text-ink-3">No messages yet. Say hello to {agent.name}.</p>}
        {messages.map((c) => {
          const mine = !c.authorAgentId;
          const who = mine ? names.user(c.authorUserId) : names.agent(c.authorAgentId);
          return (
            <div key={c.id} className={`flex gap-3 ${mine ? "flex-row-reverse" : ""}`}>
              <Avatar name={who} hue={mine ? 210 : org.hue + 40} size={28} />
              <div className={`max-w-[80%] min-w-0 ${mine ? "text-right" : ""}`}>
                <div className="text-xs text-ink-3 mb-0.5">{who} · {ago(c.createdAt)}</div>
                <p className={`inline-block text-left text-sm whitespace-pre-wrap break-words rounded-xl px-3.5 py-2 ${mine ? "bg-surface-3 text-ink" : "text-ink-2"}`}>{c.body}</p>
              </div>
            </div>
          );
        })}
        {writing && <Spinner label={`${agent.name} is writing`} />}
        <div ref={end} />
      </div>
      <div className="p-4 border-t border-line space-y-2">
        <Textarea aria-label={`Message ${agent.name}`} rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } }} placeholder={`Message ${agent.name}. Enter sends, Shift+Enter adds a line.`} className="min-h-16" />
        <div className="flex items-center justify-between gap-3"><ActionError error={error} /><Button className="ml-auto" variant="primary" size="sm" disabled={!text.trim()} loading={w.open.isPending || send.isPending} onClick={() => void submit()}><Send className="h-3.5 w-3.5" />Send</Button></div>
      </div>
      {block && (
        <Notice tone="warning" className="m-4 mt-0" title={block.reason}
          action={<div className="flex flex-wrap gap-2">
            {block.fix === "agent-containers" && <Link to={settingsHref("agent-containers")} className="text-accent hover:underline text-compact self-center">Open Agent containers</Link>}
            {block.fix === "agent" && <Link to={`${base}/agents/${agent.id}`} className="text-accent hover:underline text-compact self-center">Open {agent.name}</Link>}
            <Button size="sm" loading={retrying} onClick={() => void retry()}>Try again</Button>
          </div>}>
          {block.todo}
        </Notice>
      )}
    </Card>
  );
}
