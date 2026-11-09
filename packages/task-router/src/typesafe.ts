/** A small server-side client for TypeSafe's System One API (POST /v1/systemone). The key never leaves this module. */

export interface NoulAnswer { type: "noul"; noul: number }
export interface ChoiceAnswer { type: "choice"; choice: string; probabilities: Record<string, number> }
export type Answer = NoulAnswer | ChoiceAnswer | { type: string; [k: string]: unknown };
export type Question = { type: "noul" | "choice"; instructions: string; criteria?: Record<string, string> };

/** The one thing the rest of the package needs from TypeSafe. Tests replace it with a fake. */
export type Ask = (state: unknown, questions: Record<string, Question>) => Promise<Record<string, Answer>>;

export class TypeSafeError extends Error {}

export interface TypeSafeOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Called with the exact payload before it is sent (the key is not in it), for logging. */
  onRequest?: (payload: unknown) => void;
}

export function createTypeSafeAsk(o: TypeSafeOptions): Ask {
  const f = o.fetch ?? fetch;
  const url = `${(o.baseUrl ?? "https://api.typesafe.ai").replace(/\/+$/, "")}/v1/systemone`;
  // Errors are rewritten so a key can't reach a log or the console.
  const redact = (s: string) => s.split(o.apiKey).join("[key]");
  return async (state, questions) => {
    const payload = { model: o.model ?? "jev-latest", state, questions };
    o.onRequest?.(payload);
    let res: Response;
    try {
      res = await f(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${o.apiKey}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
      });
    } catch (e) {
      throw new TypeSafeError(redact(`Could not reach TypeSafe: ${(e as Error).message}`));
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new TypeSafeError("TypeSafe rejected the API key.");
    if (!res.ok) throw new TypeSafeError(redact(`TypeSafe answered ${res.status}: ${text.slice(0, 200)}`));
    let body: { answers?: Record<string, Answer> };
    try { body = JSON.parse(text); } catch { throw new TypeSafeError("TypeSafe sent an answer that is not JSON."); }
    if (!body.answers || typeof body.answers !== "object") throw new TypeSafeError("TypeSafe's answer had no `answers`.");
    return body.answers;
  };
}
