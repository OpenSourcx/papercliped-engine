import { useMemo } from "react";
import { ConversationList } from "./ConversationList.tsx";
import { usePin } from "./PinContext.tsx";

/** Pin's saved chats, like a chat list: newest first, rename and delete in place. Only on a device (demo chats aren't kept). */
export function ChatList({ className, onPick }: { className?: string; onPick?: () => void }) {
  const pin = usePin();
  const items = useMemo(() => pin.chats.map((c) => ({ key: c.id, source: "pin" as const, title: c.title, updatedAt: new Date(c.updatedAt).getTime() })), [pin.chats]);
  return (
    <ConversationList
      label="Saved chats"
      className={className}
      items={items}
      activeKey={pin.chatId}
      empty="Your conversations with Pin are kept here."
      onNew={() => { pin.newChat(); onPick?.(); }}
      onPick={(c) => { void pin.openChat(c.key); onPick?.(); }}
      onRename={(c, title) => pin.renameChat(c.key, title)}
      onDelete={(c) => pin.deleteChat(c.key)}
    />
  );
}
