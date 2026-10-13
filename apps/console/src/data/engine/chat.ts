import { useMutation, useQueryClient } from "@tanstack/react-query";
import { EngineError } from "@papercliped-engine/engine-client";
import { engine } from "./queries.ts";
import { qk } from "./keys.ts";

/** True when the engine answered that Agent chat is switched off (an experimental setting an instance admin turns on). */
export function chatDisabled(error: unknown): boolean {
  return error instanceof EngineError && error.status === 404 && /disabled/i.test(error.message);
}

/** Sends one chat message and refreshes the thread, the chat list and the activity it causes. */
export function useSendChat(companyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ issueId, body }: { issueId: string; body: string }) => engine.chat.send(issueId, body),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: qk.anyComments(companyId) }), qc.invalidateQueries({ queryKey: qk.chats(companyId) }), qc.invalidateQueries({ queryKey: qk.activity(companyId) })]),
  });
}
