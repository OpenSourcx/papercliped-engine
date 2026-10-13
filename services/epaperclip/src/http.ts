import type { IncomingMessage, ServerResponse } from "node:http";

/** Small HTTP helpers shared by the host service's routes. */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const MAX_BODY = 8 * 1024;
/** How long a JSON request body may take to arrive. Sign-in reads one before anyone is known, so a trickle can't hold a connection open for hours. */
export const limits = { bodyTimeoutMs: 30_000 };

export function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string | string[]> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

export async function readJson(req: IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown>> {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "json_only", "Send JSON");
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: NodeJS.Timeout | undefined;
  const slow = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(408, "request_timeout", "The request took too long to arrive")), limits.bodyTimeoutMs);
  });
  slow.catch(() => {});
  const read = (async () => {
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > max) throw new HttpError(413, "too_large", "Request body too large");
      chunks.push(c as Buffer);
    }
  })();
  read.catch(() => {});
  try {
    await Promise.race([read, slow]);
  } finally {
    clearTimeout(timer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, "bad_json", "Body must be a JSON object");
  }
}
