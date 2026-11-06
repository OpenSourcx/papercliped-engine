import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from "node:crypto";

/** A stand-in for Papercliped Connect's pairing API that really verifies the device's signatures. */
export function fakeConnect() {
  const pairings = new Map<string, { token: string; jwk: JsonWebKey; proven: boolean; accountId?: string; consumed?: boolean; expiresAt: number }>();
  const calls: string[] = [];
  const state = { down: false, now: () => Date.now() };
  const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const check = (jwk: JsonWebKey, msg: string, sig: unknown) =>
    typeof sig === "string" && verify("sha256", Buffer.from(msg), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));

  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (state.down) throw new Error("connect is down");
    const path = new URL(url).pathname;
    calls.push(path);
    const b = JSON.parse(String(init.body ?? "{}"));
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
    return ok({ deviceId: randomUUID() });
  };
  return {
    fetch, calls, state,
    /** The signed-in owner approves in the Connect console. */
    approve(accountId: string) { for (const p of pairings.values()) if (p.proven && !p.accountId) p.accountId = accountId; },
    thumbprintOf: (jwk: JsonWebKey) => createHash("sha256").update(createPublicKey({ key: jwk, format: "jwk" }).export({ format: "der", type: "spki" })).digest("base64url"),
  };
}
