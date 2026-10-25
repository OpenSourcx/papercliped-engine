import { useChatsOf } from "../../data/engine/more.ts";
import { useEngine } from "../../data/store.tsx";
import { readJson } from "../../lib/storage.ts";

/** Where PinView keeps what you have read: when you first came (older counts as read) and when you last opened each conversation. */
export const SEEN = "epc.pinview.seen";
export const SINCE = "epc.pinview.since";

/** Unread organization chats across the device, for the rail's PinView badge. Reads PinView's record of what you opened. */
export function usePinViewUnread(): number {
  const { data, live } = useEngine();
  const ids = live ? data.orgs.flatMap((o) => (o.engine ? [o.engine.companyId] : [])) : [];
  const chats = useChatsOf(ids);
  const since = readJson<number | null>(SINCE, null);
  if (since === null) return 0;
  const seen = readJson<Record<string, number>>(SEEN, {});
  let n = 0;
  chats.forEach((q, i) => {
    for (const c of q.data ?? []) {
      if (!c.conversationAgentId) continue;
      const key = `agent:${ids[i]}:${c.conversationAgentId}`;
      if (new Date(c.updatedAt).getTime() > (seen[key] ?? since)) n++;
    }
  });
  return n;
}
