import { describe, expect, it } from "vitest";
import { Publishing } from "../src/publishing.ts";
import { StateStore } from "../src/state.ts";

const TOKEN = "cf-test-token-0123456789abcdef";

describe("machine-wide publishing", () => {
  it("keeps a Cloudflare token in the vault and never returns it", async () => {
    const seen: string[] = [];
    const publishing = new Publishing(new StateStore(null), async (url, init) => {
      seen.push(`${url} ${String((init.headers as Record<string, string>).Authorization)}`);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }, () => 100);
    expect(publishing.list()[0]).toMatchObject({ id: "cloudflare", kind: "hosting", configured: false, machineWide: true });
    expect(publishing.setToken(TOKEN, "sam@pam")).toMatchObject({ configured: true, updatedBy: "sam@pam" });
    expect(JSON.stringify(publishing.list())).not.toContain(TOKEN);
    await publishing.test();
    expect(seen).toEqual([`https://api.cloudflare.com/client/v4/user/tokens/verify Bearer ${TOKEN}`]);
    expect(publishing.list()[0]).toMatchObject({ ok: true, testedAt: 100 });
  });

  it("lists only well-formed active zones and makes a stable, login-protected plan", async () => {
    const publishing = new Publishing(new StateStore(null), async (url) => {
      if (String(url).includes("/zones?")) return new Response(JSON.stringify({ result: [{ id: "z1", name: "papercliped.co" }, { id: 3, name: "bad" }] }), { status: 200 });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    publishing.setToken(TOKEN, "sam@pam");
    await expect(publishing.zones()).resolves.toEqual([{ id: "z1", name: "papercliped.co" }]);
    expect(publishing.plan("papercliped.co", "app")).toEqual({ provider: "cloudflare", hostname: "app.papercliped.co", origin: "https://127.0.0.1:443", access: "epaperclip-login", mode: "named-tunnel" });
    expect(() => publishing.plan("papercliped.co", "app.example")).toThrow("one subdomain label");
  });
});
