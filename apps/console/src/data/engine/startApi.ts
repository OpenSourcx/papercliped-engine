import { NodeApiError } from "./nodeApi.ts";

/** Helpers for the start-a-company wizard that the engine doesn't provide. */

export interface CeoDraft { name: string; title: string; summary: string }

export const startApi = {
  /** Pin drafts a CEO for a new organization (POST /api/pin/draft-ceo). Nothing is created; the person reviews the draft. */
  async draftCeo(orgName: string, description: string): Promise<CeoDraft> {
    let res: Response;
    try {
      res = await fetch("/api/pin/draft-ceo", { method: "POST", credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ orgName, description }) });
    } catch {
      throw new NodeApiError(0, "Can't reach this device", "offline");
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const d = (data ?? {}) as { error?: string; code?: string };
      throw new NodeApiError(res.status, d.error ?? `Request failed (${res.status})`, d.code ?? null);
    }
    return data as CeoDraft;
  },
};
