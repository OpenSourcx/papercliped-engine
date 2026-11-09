import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from "node:crypto";
import { canonicalIdentityMessage, challengeOf } from "../src/identityLinkCrypto.ts";

/** A stand-in for Papercliped Connect's pairing API that really verifies the device's signatures. */
export function fakeConnect() {
  const pairings = new Map<string, { token: string; jwk: JsonWebKey; proven: boolean; accountId?: string; consumed?: boolean; denied?: boolean; expiresAt: number }>();
  const calls: string[] = [];
  const devices = new Map<string, JsonWebKey>();
  const identity = new Map<string, { deviceId: string; jwk: JsonWebKey; challenge: string; kind: "association" | "federated"; principal: { userid: string; realm: string }; sessionBinding: string; userCodeHash: string; accountId?: string; role?: "owner" | "member"; state: "pending" | "approved" | "active" | "revoked" | "denied"; expiresAt: number }>();
  const oidcClients = new Map<string, { clientId: string; clientSecret: string; redirectUris: string[] }>();
  /** `tunnel`: what the credentials endpoint answers once the signature checks out. */
  const state = { down: false, now: () => Date.now(), tunnel: "ok" as "ok" | "not_ready" | "no_entitlement" | "not_available" | "error" | "garbage", hostname: "lab-1a2b3c.connect.papercliped.co", token: "eyJhIjoiYWNjdCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=", tunnelCalls: 0, revoke: "ok" as "ok" | "error", revokedDevices: [] as string[] };
  const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const check = (jwk: JsonWebKey, msg: string, sig: unknown) =>
    typeof sig === "string" && verify("sha256", Buffer.from(msg), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));

  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (state.down) throw new Error("connect is down");
    const path = new URL(url).pathname;
    calls.push(path);
    const b = JSON.parse(String(init.body ?? "{}"));
    // OIDC client per device: one confidential client, secret shown once.
    const oidcRoute = /^\/api\/v1\/devices\/([0-9a-f-]{36})\/oidc-client$/.exec(path);
    if (oidcRoute) {
      const deviceId = oidcRoute[1]!;
      const jwk = devices.get(deviceId);
      const fresh = Number.isSafeInteger(b.ts) && Math.abs(Math.floor(state.now() / 1000) - b.ts) <= 60;
      const removing = init.method === "DELETE";
      const action = removing ? "oidc-remove" : "oidc-register";
      const fields: [string, string | number][] = removing
        ? [["deviceId", deviceId], ["ts", b.ts]]
        : [["deviceId", deviceId], ["ts", b.ts], ["redirectUris", Array.isArray(b.redirectUris) ? b.redirectUris.join("\n") : ""]];
      if (!jwk || !fresh || JSON.stringify(b.publicKeyJwk) !== JSON.stringify(jwk) || !check(jwk, canonicalIdentityMessage(action, fields), b.signature)) return ok({ error: "not_available" }, 403);
      if (removing) { oidcClients.delete(deviceId); return ok({ ok: true }); }
      if (oidcClients.has(deviceId)) return ok({ error: "already_registered" }, 409);
      const client = { clientId: "ep-" + deviceId, clientSecret: randomBytes(32).toString("base64url"), redirectUris: Array.isArray(b.redirectUris) ? b.redirectUris : [] };
      oidcClients.set(deviceId, client);
      return ok({ issuer: "https://auth.test/oidc", ...client }, 201);
    }

    const ident = /^\/api\/v1\/devices\/([0-9a-f-]{36})\/identity-links(?:\/([0-9a-f-]{36})(?:\/(poll|confirm|revoke))?|\/reconcile)?$/.exec(path);
    if (ident) {
      const deviceId = ident[1]!, linkId = ident[2], act = ident[3] ?? (path.endsWith("/reconcile") ? "reconcile" : ident[2] ? undefined : "start");
      const jwk = devices.get(deviceId);
      const fresh = Number.isSafeInteger(b.ts) && Math.abs(Math.floor(state.now() / 1000) - b.ts) <= 60;
      const action = act === "start" ? "start" : act === "poll" ? "poll" : act === "confirm" ? "confirm" : act === "revoke" ? "revoke" : act === "reconcile" ? "reconcile" : null;
      const fields: [string, string | number][] = action === "start" ? [
        ["deviceId", deviceId], ["ts", b.ts], ["linkId", b.linkId], ["challenge", b.challenge], ["kind", b.kind],
        ["principalUserid", b.principal?.userid ?? ""], ["principalRealm", b.principal?.realm ?? ""], ["sessionBinding", b.sessionBinding],
        ["userCodeHash", b.userCodeHash], ["returnOrigin", b.returnOrigin], ["returnPath", b.returnPath],
        ["confirmWindowSec", b.confirmWindowSec], ["replaceLinkId", b.replaceLinkId ?? ""],
      ] : action === "poll" ? [["deviceId", deviceId], ["linkId", linkId ?? ""], ["ts", b.ts]]
        : action === "confirm" ? [
          ["deviceId", deviceId], ["linkId", linkId ?? ""], ["ts", b.ts], ["kind", b.kind], ["accountId", b.accountId],
          ["principalUserid", b.principal?.userid ?? ""], ["principalRealm", b.principal?.realm ?? ""],
          ["sessionBinding", b.sessionBinding], ["challenge", b.challenge ?? ""], ["linkExpiresAt", b.linkExpiresAt],
          ["approvedBy", b.approvedBy], ["membership", b.membership],
        ] : action === "revoke" ? [["deviceId", deviceId], ["linkId", linkId ?? ""], ["ts", b.ts], ["initiator", b.initiator], ["reason", b.reason]]
          : action === "reconcile" ? [["deviceId", deviceId], ["ts", b.ts], ["cursor", b.cursor ?? ""]] : [];
      if (!action || !jwk || !fresh || JSON.stringify(b.publicKeyJwk) !== JSON.stringify(jwk) || !check(jwk, canonicalIdentityMessage(action, fields), b.signature)) return ok({ error: "not_available" }, 403);
      if (action === "start") {
        if (typeof b.linkId !== "string" || typeof b.challenge !== "string" || (b.kind !== "association" && b.kind !== "federated")) return ok({ error: "bad_request" }, 400);
        identity.set(b.linkId, { deviceId, jwk, challenge: b.challenge, kind: b.kind, principal: b.principal, sessionBinding: b.sessionBinding, userCodeHash: b.userCodeHash, state: "pending", expiresAt: state.now() + Number(b.confirmWindowSec) * 1000 });
        return ok({ linkId: b.linkId, approvalPath: "/devices/link?lid=" + b.linkId, expiresAt: state.now() + Number(b.confirmWindowSec) * 1000 }, 201);
      }
      if (action === "reconcile") return ok({ links: [...identity.values()].filter((x) => x.deviceId === deviceId).map((x) => ({ linkId: [...identity.entries()].find(([, v]) => v === x)?.[0], state: x.state, accountId: x.accountId, principal: x.principal, role: x.role, updatedAt: state.now() })) });
      const it = linkId ? identity.get(linkId) : undefined;
      if (!it || it.deviceId !== deviceId) return ok({ error: "not_found" }, 404);
      if (action === "poll") return ok({ state: it.state, expiresAt: it.expiresAt, account: it.accountId ? { id: it.accountId, displayName: "Owner", idSuffix: it.accountId.slice(-6) } : null, role: it.role ?? null });
      if (action === "revoke") { it.state = "revoked"; return ok({ ok: true }); }
      // confirm: the verifier must hash to the start challenge, the account must match, and the link must still be approved.
      if (it.state !== "approved" || it.accountId !== b.accountId) return ok({ error: it.accountId && it.accountId !== b.accountId ? "account_mismatch" : "bad_state" }, 409);
      if (typeof b.verifier !== "string" || challengeOf(b.verifier) !== it.challenge) return ok({ error: "verifier_mismatch" }, 403);
      it.state = "active";
      it.role = it.accountId === "acct_owner" ? "owner" : "member";
      return ok({ ok: true, linkId, state: "active", role: it.role });
    }

    const rev = /^\/api\/v1\/devices\/([0-9a-f-]{36})\/device-revoke$/.exec(path);
    if (rev) {
      const jwk = devices.get(rev[1]!);
      const fresh = Number.isSafeInteger(b.ts) && Math.abs(Math.floor(state.now() / 1000) - b.ts) <= 60;
      if (!jwk || !fresh || JSON.stringify(b.publicKeyJwk) !== JSON.stringify(jwk) || !check(jwk, `papercliped-connect:revoke:v1:${rev[1]}:${b.ts}`, b.signature)) return ok({ error: "not_available" }, 403);
      if (state.revoke === "error") return ok({ error: "boom" }, 500);
      state.revokedDevices.push(rev[1]!); devices.delete(rev[1]!);
      return ok({ revoked: true }, 202);
    }
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
    if (m[2] === "poll") return ok({ state: p.denied ? "denied" : p.consumed ? "consumed" : p.accountId ? "approved" : "pending", proven: p.proven, accountId: p.accountId ?? null });
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
    /** The signed-in owner declines in the Connect console. */
    deny() { for (const p of pairings.values()) if (p.proven && !p.accountId) p.denied = true; },
    /** The account holder approves one identity link in their browser. */
    approveIdentity(accountId: string, linkId?: string) {
      for (const [id, it] of identity) if (it.state === "pending" && (!linkId || id === linkId)) { it.accountId = accountId; it.state = "approved"; }
    },
    identityLinks: identity,
    oidcClients,
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
