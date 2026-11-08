import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./http.ts";
import type { EngineGateway } from "./engine.ts";

const SIGNATURE_HEADERS = ["content-type", "x-slack-signature", "x-slack-request-timestamp", "x-hub-signature-256", "x-github-event", "x-github-delivery", "x-signature-ed25519", "x-signature-timestamp"];
export const CHANNEL_INGRESS = /^\/api\/chat-webhooks\/([A-Za-z0-9_-]{32,128})\/(slack|github|discord)$/;

/** Public, signed provider ingress. No browser cookies or engine account are used. */
export async function channelIngress(req: IncomingMessage, res: ServerResponse, path: string, gateway: Pick<EngineGateway, "relayChatWebhook">): Promise<void> {
  const match = CHANNEL_INGRESS.exec(path);
  if (!match || req.method !== "POST") throw new HttpError(404, "not_found", "Not found");
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: NodeJS.Timeout | undefined;
  const read = (async () => {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 1024 * 1024) throw new HttpError(413, "too_large", "Provider request is too large.");
      chunks.push(bytes);
    }
  })();
  try {
    await Promise.race([read, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(408, "request_timeout", "Provider request timed out.")), 15_000); })]);
  } finally { clearTimeout(timer); }
  const headers: Record<string, string> = {};
  for (const name of SIGNATURE_HEADERS) { const value = req.headers[name]; if (typeof value === "string") headers[name] = value; }
  // Preserve the exact signed bytes. The native engine verifies signatures, replay windows and endpoint ownership.
  const reply = await gateway.relayChatWebhook(match[1], match[2], headers, Buffer.concat(chunks));
  res.writeHead(reply.status, { "Content-Type": reply.contentType === "application/json" ? "application/json" : "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(reply.text);
}
