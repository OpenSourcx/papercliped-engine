import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { fakeAccessPve } from "./fakes-access.ts";

/** A running host service wired to the fake Proxmox access API, with a clock the test controls. */
export async function startAccessApp(extra: { engine?: Parameters<typeof createApp>[0]["engine"] } = {}) {
  const pve = fakeAccessPve();
  const clock = { t: 1_800_000_000_000 };
  const now = () => clock.t;
  const sessions = new SessionStore(now);
  const state = new StateStore(mkdtempSync(join(tmpdir(), "epc-access-")));
  const app = createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: pve.transport }, sessions, staticDir: null, secureCookies: false, state, now, ...extra });
  const server: Server = createServer(app);
  server.on("upgrade", app.upgrade);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signIn = async (username: string) => {
    const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username, password: "right", realm: "pve" }) });
    if (r.status !== 200) throw new Error(`sign-in failed ${r.status}`);
    return r.headers.get("set-cookie")!.split(";")[0];
  };
  /** A request with a cookie session (which adds the page header), a Bearer token, or both. */
  const call = (method: string, path: string, auth: { cookie?: string; bearer?: string; headers?: Record<string, string> } = {}, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(method !== "GET" && auth.cookie ? { "X-EPC-Request": "1" } : {}),
        ...(auth.cookie ? { Cookie: auth.cookie } : {}),
        ...(auth.bearer ? { Authorization: `Bearer ${auth.bearer}` } : {}),
        ...auth.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { pve, state, sessions, base, clock, signIn, call, close };
}
