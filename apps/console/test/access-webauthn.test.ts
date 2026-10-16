// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerChallenge, b64uToBytes, bytesToB64u, registerKey, webauthnUsableHere } from "../src/pages/access/webauthn.ts";

afterEach(() => vi.unstubAllGlobals());

describe("base64url", () => {
  it("round-trips bytes, with no padding and URL-safe letters", () => {
    const bytes = new Uint8Array([251, 255, 190, 0, 1, 2]);
    const text = bytesToB64u(bytes);
    expect(text).toBe("-_--AAEC");
    expect([...b64uToBytes(text)]).toEqual([...bytes]);
    expect(bytesToB64u(b64uToBytes("YQ"))).toBe("YQ");
  });
});

describe("whether a key made here would work", () => {
  const here = { origin: "https://epc.example.org", hostname: "epc.example.org" };
  it("needs Proxmox's address to be this page's", () => {
    expect(webauthnUsableHere(null, here).ok).toBe(false);
    expect(webauthnUsableHere({ id: "example.org", origin: "https://epc.example.org", allowSubdomains: true }, here).ok).toBe(true);
    const other = webauthnUsableHere({ id: "pve.example.org", origin: "https://pve.example.org:8006", allowSubdomains: false }, here);
    expect(other.ok).toBe(false);
    expect(other.why).toMatch(/8006/);
    expect(webauthnUsableHere({ id: "example.org", origin: "https://example.org", allowSubdomains: true }, here).ok).toBe(true);
    expect(webauthnUsableHere({ id: "example.org", origin: "https://example.org", allowSubdomains: false }, here).ok).toBe(false);
    expect(webauthnUsableHere({ id: "other.org", origin: "https://epc.example.org", allowSubdomains: false }, here).ok).toBe(false);
  });
});

describe("talking to the browser", () => {
  it("registers a key: bytes in, base64url answer out, challenge kept as text", async () => {
    const create = vi.fn(async (o: any) => {
      expect(o.publicKey.challenge).toBeInstanceOf(Uint8Array);
      expect(o.publicKey.user.id).toBeInstanceOf(Uint8Array);
      return { id: "cred", type: "public-key", rawId: new Uint8Array([1, 2]).buffer, response: { attestationObject: new Uint8Array([3]).buffer, clientDataJSON: new Uint8Array([4]).buffer } };
    });
    vi.stubGlobal("navigator", { credentials: { create } });
    const r = await registerKey(JSON.stringify({ publicKey: { challenge: "YWJj", user: { id: "dXNlcg", name: "a" }, excludeCredentials: [{ id: "AQI", type: "public-key" }] } }));
    expect(r.challenge).toBe("YWJj");
    expect(JSON.parse(r.value)).toEqual({ id: "cred", type: "public-key", rawId: "AQI", response: { attestationObject: "Aw", clientDataJSON: "BA" } });
  });

  it("answers a sign-in challenge", async () => {
    const get = vi.fn(async (o: any) => {
      expect(o.publicKey.allowCredentials[0].id).toBeInstanceOf(Uint8Array);
      return { id: "cred", type: "public-key", rawId: new Uint8Array([1]).buffer, response: { authenticatorData: new Uint8Array([2]).buffer, clientDataJSON: new Uint8Array([3]).buffer, signature: new Uint8Array([4]).buffer } };
    });
    vi.stubGlobal("navigator", { credentials: { get } });
    const json = JSON.parse(await answerChallenge({ publicKey: { challenge: "YWJj", allowCredentials: [{ type: "public-key", id: "Y3JlZA" }] } }));
    expect(json).toMatchObject({ id: "cred", response: { authenticatorData: "Ag", signature: "BA" } });
  });
});
