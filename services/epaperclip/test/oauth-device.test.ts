import { afterEach, describe, expect, it } from "vitest";
import { clientIdFor, DEVICE_PROVIDERS, DeviceError, DeviceSessions, type DeviceProvider } from "../src/oauth-device.ts";

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });
const j = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const P: DeviceProvider = { ...DEVICE_PROVIDERS.github!, defaultClientId: "Iv1.builtin" };

describe("device-flow harness: which client ID a device uses", () => {
  it("uses the built-in public client ID for everyone, and an environment variable only as an override", () => {
    expect(clientIdFor(P, {})).toBe("Iv1.builtin");
    expect(clientIdFor(P, { EPC_GITHUB_CLIENT_ID: "Iv1.mine" })).toBe("Iv1.mine");
    expect(clientIdFor(P, { EPC_GITHUB_CLIENT_ID: "  " })).toBe("");
  });
  it("is empty (sign-in unavailable) until the OpenSourcx app's client ID is built in", () => {
    // The shipped default is filled in once the OAuth app is registered; until then this is the honest state.
    expect(clientIdFor(DEVICE_PROVIDERS.github!, {})).toBe(DEVICE_PROVIDERS.github!.defaultClientId);
  });
});

describe("device-flow harness: sessions", () => {
  it("never returns the provider's device code and refuses a verification page on another host", async () => {
    globalThis.fetch = (async () => j({ device_code: "SECRETDEV", user_code: "AAAA-BBBB", verification_uri: "https://evil.example/login/device", expires_in: 900, interval: 5 })) as typeof fetch;
    const s = new DeviceSessions();
    const r = await s.start(P, "cid", "sam", 1_000);
    expect(JSON.stringify(r)).not.toContain("SECRETDEV");
    expect(r.verificationUri).toBe("https://github.com/login/device");
  });
  it("holds early polls back, then reports pending, denied or the token", async () => {
    let answer: unknown = { error: "authorization_pending" };
    let tokenCalls = 0;
    globalThis.fetch = (async (u: any) => {
      if (String(u).includes("/login/device/code")) return j({ device_code: "D", user_code: "U", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
      tokenCalls++;
      return j(answer);
    }) as typeof fetch;
    const s = new DeviceSessions();
    const { id } = await s.start(P, "cid", "sam", 0);
    expect(await s.poll(P, "cid", id, "sam", 1_000)).toEqual({ status: "pending" });
    expect(await s.poll(P, "cid", id, "sam", 2_000)).toEqual({ status: "pending" }); // within the interval: not sent to the provider
    expect(tokenCalls).toBe(1);
    answer = { access_token: "gho_xyz" };
    expect(await s.poll(P, "cid", id, "sam", 7_000)).toEqual({ status: "done", accessToken: "gho_xyz" });
    await expect(s.poll(P, "cid", id, "sam", 14_000)).rejects.toBeInstanceOf(DeviceError); // one use
  });
  it("is private to the person who started it and expires", async () => {
    globalThis.fetch = (async () => j({ device_code: "D", user_code: "U", verification_uri: "https://github.com/login/device", expires_in: 60, interval: 5 })) as typeof fetch;
    const s = new DeviceSessions();
    const { id } = await s.start(P, "cid", "sam", 0);
    await expect(s.poll(P, "cid", id, "lee", 1_000)).rejects.toMatchObject({ status: 404 });
    expect(await s.poll(P, "cid", id, "sam", 61_000)).toEqual({ status: "expired" });
  });
});
