import { createContext, useContext } from "react";
import { usePin } from "./PinContext.tsx";
import type { ThreadMessage, ToolState } from "./useThread.ts";

/**
 * What a conversation view needs from whichever conversation it shows. Pin's island and page get it from Pin itself; PinView
 * wraps an organization's agent chat in a provider so the same thread, cards and composer draw it.
 */
export interface ThreadApi {
  messages: ThreadMessage[];
  thinking: boolean;
  streaming: boolean;
  send: (text: string, opts?: { inPlace?: boolean }) => void;
  stop: () => void;
  markDone: (id: string) => void;
  resolveTool: (id: string, patch: Pick<ToolState, "resolved" | "note">) => void;
  /** Who the person is talking to, for the composer's label ("Pin" by default). */
  name?: string;
  /** Starts a new chat from the composer's "/new". Pin provides it; a conversation that has only one chat doesn't. */
  newChat?: () => void;
  /** True when this is an organization's agent chat. The line under the composer then reads Pin's settings, so it can't change them. */
  agentChat?: boolean;
}

const Ctx = createContext<ThreadApi | null>(null);
export const ThreadProvider = Ctx.Provider;

export function useThreadApi(): ThreadApi {
  const given = useContext(Ctx);
  const pin = usePin();
  return given ?? pin;
}
