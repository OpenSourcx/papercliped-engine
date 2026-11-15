import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { run } from "../../../deploy/epaperclip-login.mjs";
import { ConnectLink } from "../src/connectLink.ts";
import { ctlHandler, listenCtl } from "../src/ctl.ts";
import { StateStore } from "../src/state.ts";
import { fakeConnect, fakeTunnelHelper } from "./fakes-papercliped.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

/** The real CLI against the real control socket and ConnectLink, with a fake Connect. */
async function host() {
  const dir = mkdtempSync(join(tmpdir(), "epc-login-"));
  const fc = fakeConnect();
  const link = new ConnectLink(new StateStore(null), fc.fetch, "https://connect.test", () => fc.state.now(), { helper: fakeTunnelHelper().helper });
  const socketPath = join(dir, "ctl.sock");
  const server = listenCtl(socketPath, ctlHandler({ link, revokeIdentityLinks: async () => {} }));
  await new Promise((r) => server.on("listening", r));
  cleanup.push(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  const make = (answers: string[] = [], opts: { isTTY?: boolean; onSleep?: (n: number) => void; signal?: AbortSignal } = {}) => {
    const out: string[] = [], err: string[] = [], asked: string[] = [];
    let n = 0;
    return { out, err, asked, io: {
      out: (s: string) => out.push(s), err: (s: string) => err.push(s), isTTY: opts.isTTY ?? true,
      ask: async (q: string) => { asked.push(q); return answers.shift() ?? null; },
      sleep: async () => { opts.onSleep?.(++n); }, now: () => fc.state.now(), socketPath, hostname: () => "pve-lab", signal: opts.signal,
    } };
  };
  const sh = (c: ReturnType<typeof make>, ...argv: string[]) => run(argv, c.io) as Promise<number>;
  return { fc, link, make, sh, socketPath };
}

describe("epaperclip login | logout | whoami", () => {
  it("links this computer: shows the code and address, waits, shows the approving account, asks, confirms; whoami and logout follow", async () => {
    const h = await host();
    const c = h.make(["y"], { onSleep: (n) => { if (n === 2) h.fc.approve("acct_one"); } });
    expect(await h.sh(c, "login")).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("https://link.papercliped.co");
    expect(text).not.toContain("?code=");                       // the typed code is the interface; the deep link stays in the web UI
    expect(text).toContain("K7MQ-4XW2");
    expect(text).toMatch(/Approved by Papercliped account acct_one/);
    expect(c.asked[0]).toContain("acct_one");
    expect(text).toMatch(/Linked as "pve-lab" to Papercliped account acct_one/);
    expect(h.link.status().device).toMatchObject({ accountId: "acct_one", name: "pve-lab" });

    const w = h.make(); expect(await h.sh(w, "whoami")).toBe(0);
    expect(w.out.join("\n")).toContain('"pve-lab"'); expect(w.out.join("\n")).toContain("acct_one");
    const again = h.make(); expect(await h.sh(again, "login")).toBe(0);
    expect(again.out.join("\n")).toMatch(/Already linked/); expect(again.asked).toEqual([]);

    const out = h.make(["n"]); expect(await h.sh(out, "logout")).toBe(1);   // declined: nothing changes
    expect(h.link.status().paired).toBe(true);
    const out2 = h.make(["yes"]); expect(await h.sh(out2, "logout")).toBe(0);
    expect(h.link.status().paired).toBe(false);
    const gone = h.make(); expect(await h.sh(gone, "whoami")).toBe(1);
    expect(gone.out.join("\n")).toMatch(/not linked/);
  });

  it("declining the account at the prompt links nothing and clears the request", async () => {
    const h = await host();
    const c = h.make(["n"], { onSleep: (n) => { if (n === 1) h.fc.approve("acct_stranger"); } });
    expect(await h.sh(c, "login")).toBe(1);
    expect(h.link.status().paired).toBe(false); expect(h.link.status().pairing).toBeUndefined();
    expect(c.out.join("\n")).toMatch(/Nothing was linked/);
  });

  it("--name and --yes: no questions asked, the chosen name is used", async () => {
    const h = await host();
    const c = h.make([], { isTTY: false, onSleep: (n) => { if (n === 1) h.fc.approve("acct_one"); } });
    expect(await h.sh(c, "login", "--yes", "--name", "  Rack 4  ")).toBe(0);
    expect(c.asked).toEqual([]); expect(h.link.status().device?.name).toBe("Rack 4");
  });

  it("without a terminal and without --yes it refuses before starting anything", async () => {
    const h = await host();
    const c = h.make([], { isTTY: false });
    expect(await h.sh(c, "login")).toBe(2);
    expect(c.err.join("\n")).toMatch(/--yes/); expect(h.fc.calls).not.toContain("/api/v1/pairings");
    const lo = h.make([], { isTTY: false }); expect(await h.sh(lo, "logout")).toBe(0); // not linked: nothing to ask
  });

  it("an expired code, a declined request and a cancelled wait each end cleanly", async () => {
    const h1 = await host();
    const adv = h1.make([], { onSleep: () => { h1.fc.state.now = () => Date.now() + 11 * 60_000; } });
    expect(await h1.sh(adv, "login")).toBe(1); expect(adv.err.join("\n")).toMatch(/expired/);
    expect(h1.link.status().pairing).toBeUndefined();

    const h2 = await host();
    const den = h2.make([], { onSleep: (n) => { if (n === 1) h2.fc.deny(); } });
    expect(await h2.sh(den, "login")).toBe(1); expect(den.err.join("\n")).toMatch(/declined/);

    const h3 = await host(); const ctl = new AbortController();
    const can = h3.make([], { signal: ctl.signal, onSleep: () => ctl.abort() });
    expect(await h3.sh(can, "login")).toBe(130);
    expect(h3.link.status().pairing).toBeUndefined();
  });

  it("explains an ePaperclip that is not running, and bad usage", async () => {
    const h = await host();
    const c = h.make(); c.io.socketPath = join(tmpdir(), "no-such-epaperclip.sock");
    expect(await h.sh(c, "whoami")).toBe(1); expect(c.err.join("\n")).toMatch(/isn't running[\s\S]*systemctl start epaperclip/);
    expect(await h.sh(h.make(), "login", "--bogus")).toBe(2);
    expect(await h.sh(h.make(), "frobnicate")).toBe(2);
    expect(await h.sh(h.make(), "login", "--name", "")).toBe(2);
    expect(await h.sh(h.make())).toBe(2);
    const help = h.make(); expect(await h.sh(help, "--help")).toBe(0); expect(help.out.join("\n")).toContain("epaperclip login");
  });
});
