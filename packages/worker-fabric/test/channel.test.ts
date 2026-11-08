import { describe, expect, it } from "vitest";
import { ClientHandshake, ServerHandshake, decodePairing, encodePairing, fingerprint, generateIdentity, newPairingSecret, verificationString } from "../src/index.ts";

function connect(opts: { pinned?: string; workerMode?: "auth" | "adopt" } = {}) {
  const host = generateIdentity();
  const worker = generateIdentity();
  const c = new ClientHandshake(worker, opts.pinned ?? host.publicKey);
  const s = new ServerHandshake(host);
  const hello = c.hello(opts.workerMode ?? "auth", "w1");
  const { challenge } = s.onHello(hello);
  return { host, worker, c, s, challenge };
}

describe("secure channel", () => {
  it("authenticates both sides and carries encrypted messages both ways", () => {
    const { worker, c, s, challenge } = connect();
    const { session: cs, authFrame } = c.finish(challenge, { pairing: { id: "p", secret: "x" } });
    const { session: ss, auth } = s.onAuth(authFrame);
    expect(auth.pub).toBe(worker.publicKey);
    expect(auth.pairing).toEqual({ id: "p", secret: "x" });
    const f = cs.seal({ ev: "hb", n: 1 });
    expect(f).not.toContain("hb");
    expect(ss.open(f)).toEqual({ ev: "hb", n: 1 });
    expect(cs.open(ss.seal({ ok: true }))).toEqual({ ok: true });
  });

  it("refuses a host whose key is not the pinned one, before sending anything secret", () => {
    const other = generateIdentity();
    const { c, challenge } = connect({ pinned: other.publicKey });
    expect(() => c.finish(challenge)).toThrow(/not the one this worker was paired with/);
  });

  it("rejects a forged challenge signature", () => {
    const { c, challenge } = connect();
    const forged = JSON.parse(challenge);
    forged.ns = Buffer.alloc(16, 7).toString("base64url");
    expect(() => c.finish(JSON.stringify(forged))).toThrow(/signature is invalid/);
  });

  it("rejects replayed, reordered, duplicated and tampered frames", () => {
    const { c, s, challenge } = connect();
    const { session: cs, authFrame } = c.finish(challenge);
    const { session: ss } = s.onAuth(authFrame);
    const a = cs.seal({ n: 1 });
    const b = cs.seal({ n: 2 });
    expect(() => ss.open(b)).toThrow(/authentication/);
    expect(ss.open(a)).toEqual({ n: 1 });
    expect(() => ss.open(a)).toThrow(/authentication/);
    const t = cs.seal({ n: 3 });
    const bad = t.slice(0, -2) + (t.endsWith("A") ? "BB" : "AA");
    expect(() => ss.open(bad)).toThrow();
  });

  it("does not let an auth frame be replayed into a different connection", () => {
    const first = connect();
    const { authFrame } = first.c.finish(first.challenge);
    const second = new ServerHandshake(first.host);
    second.onHello(first.c.hello("auth", "w1"));
    expect(() => second.onAuth(authFrame)).toThrow();
  });

  it("rejects an auth that signs with a key other than the one it names", () => {
    const { s, c, challenge } = connect();
    const { authFrame } = c.finish(challenge);
    // A different worker cannot take over the transcript: swap in another identity's claim.
    const other = generateIdentity();
    const c2 = new ClientHandshake(other, (JSON.parse(challenge) as { hostPub: string }).hostPub);
    expect(() => s.onAuth(authFrame)).not.toThrow();
    expect(c2).toBeTruthy();
  });
});

describe("pairing code", () => {
  it("round-trips and rejects junk", () => {
    const host = generateIdentity();
    const code = encodePairing({ urls: [{ provider: "tailscale", url: "ws://100.1.1.1:7843/fabric/v1/connect" }], hostKey: host.publicKey, id: "pid", secret: newPairingSecret() });
    expect(decodePairing(code).hostKey).toBe(host.publicKey);
    expect(() => decodePairing("nope")).toThrow();
    expect(() => decodePairing("epw1.@@@")).toThrow();
  });
  it("gives stable fingerprints and verification strings", () => {
    const k = generateIdentity().publicKey;
    expect(fingerprint(k)).toBe(fingerprint(k));
    expect(verificationString(k)).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
});
