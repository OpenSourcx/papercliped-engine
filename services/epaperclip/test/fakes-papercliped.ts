import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from "node:crypto";

/** A stand-in for Papercliped Connect's pairing API that really verifies the device's signatures. */
export function fakeConnect() {
  const pairings = new Map<string, { token: string; jwk: JsonWebKey; proven: boolean; accountId?: string; consumed?: boolean; expiresAt: number }>();
  const calls: string[] = [];
  const devices = new Map<string, JsonWebKey>();
  /** `tunnel`: what the credentials endpoint answers once the signature checks out. */
  const state = { down: false, now: () => Date.now(), tunnel: "ok" as "ok" | "not_ready" | "no_entitlement" | "not_available" | "error" | "garbage", hostname: "lab-1a2b3c.connect.papercliped.co", token: "eyJhIjoiYWNjdCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=", tunnelCalls: 0 };
  const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const check = (jwk: JsonWebKey, msg: string, sig: unknown) =>
    typeof sig === "string" && verify("sha256", Buffer.from(msg), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));

  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (state.down) throw new Error("connect is down");
    const path = new URL(url).pathname;
    calls.push(path);
    const b = JSON.parse(String(init.body ?? "{}"));
    const dev = /^\/api\/v1\/devices\/([0-9a-f-]{36})\/tunnel-credentials$/.exec(path);
    if (dev) {
      state.tunnelCalls++;
      const jwk = devices.get(dev[1]!);
      // Same checks as Connect: known device, the registered key, a fresh timestamp, a real signature over the exact message.
      const fresh = Number.isSafeInteger(b.ts) && Math.abs(Math.floor(state.now() / 1000) - b.ts) <= 60;
      if (!jwk || !fresh || JSON.stringify(b.publicKeyJwk) !== JSON.stringify(jwk) || !check(jwk, `papercliped-connect:tunnel:v1:${dev[1]}:${b.ts}`, b.signature)) return ok({ error: "not_available" }, 403);
      if (state.tunnel === "ok") return ok({ hostname: state.hostname, tunnelToken: state.token, origin: "https://127.0.0.1:443" });
      if (state.tunnel === "not_ready") return ok({ error: "not_ready" }, 409);
      if (state.tunnel === "no_entitlement" || state.tunnel === "not_available") return ok({ error: state.tunnel }, 403);
      if (state.tunnel === "garbage") return ok({ hostname: "evil host", tunnelToken: "x", origin: "https://10.0.0.1" });
      return ok({ error: "boom" }, 500);
    }
    if (path === "/api/v1/pairings") {
      const id = randomUUID(), token = randomBytes(32).toString("base64url");
      pairings.set(id, { token, jwk: b.publicKeyJwk, proven: false, expiresAt: state.now() + 600_000 });
      return ok({ pairingId: id, token, expiresAt: pairings.get(id)!.expiresAt }, 201);
    }
    const m = /^\/api\/v1\/pairings\/([^/]+)\/(proof|poll|complete)$/.exec(path);
    const p = m && pairings.get(m[1]!);
    if (!m || !p || p.token !== b.token) return ok({ error: "not_available" }, 400);
    if (m[2] === "proof") {
      if (p.proven || !check(p.jwk, "papercliped-connect:pairing:v1:" + p.token, b.signature)) return ok({ error: "not_available" }, 400);
      p.proven = true;
      return ok({ ok: true });
    }
    if (m[2] === "poll") return ok({ state: p.consumed ? "consumed" : p.accountId ? "approved" : "pending", proven: p.proven, accountId: p.accountId ?? null });
    if (!p.accountId || p.consumed || b.accountId !== p.accountId || !check(p.jwk, `papercliped-connect:completion:v1:${m[1]}:${b.accountId}:${p.token}`, b.signature)) return ok({ error: "not_available" }, 400);
    p.consumed = true;
    const deviceId = randomUUID();
    devices.set(deviceId, p.jwk);
    return ok({ deviceId });
  };
  return {
    fetch, calls, state,
    /** The signed-in owner approves in the Connect console. */
    approve(accountId: string) { for (const p of pairings.values()) if (p.proven && !p.accountId) p.accountId = accountId; },
    thumbprintOf: (jwk: JsonWebKey) => createHash("sha256").update(createPublicKey({ key: jwk, format: "jwk" }).export({ format: "der", type: "spki" })).digest("base64url"),
  };
}

/** A stand-in for the root publishing helper: same owner rules as deploy/epaperclip-publish.mjs, in memory. */
export function fakeTunnelHelper() {
  const h = { owner: null as "self" | "connect" | null, token: null as string | null, active: false, calls: [] as string[], fail: false };
  const helper = {
    async install(owner: "self" | "connect", token: string) {
      h.calls.push("install:" + owner);
      if (h.fail) throw new Error("helper down");
      if (h.owner && h.owner !== owner) throw new Error("tunnel is owned by " + h.owner);
      Object.assign(h, { owner, token, active: true });
    },
    async remove(owner: "self" | "connect") {
      h.calls.push("remove:" + owner);
      if (h.fail) throw new Error("helper down");
      if (h.owner === owner) Object.assign(h, { owner: null, token: null, active: false });
    },
    async status() {
      if (h.fail) throw new Error("helper down");
      return { owner: h.owner, installed: h.owner !== null, active: h.active };
    },
  };
  return { h, helper };
}
